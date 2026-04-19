const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
require('dotenv').config();
const db = require('./db');

const token = process.env.TG_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL = process.env.OPENAI_MODEL;
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';

const ENABLE_QUESTION_IMAGES = String(process.env.ENABLE_QUESTION_IMAGES).toLowerCase() === 'true';

/*
WRITE_QUESTIONS_TO_DB=true  -> всё, что генерит OpenAI, пишется в таблицу игры
READ_QUESTIONS_FROM_DB=true -> бот пытается брать вопросы из БД
если READ=true и таблица пустая -> fallback на OpenAI
*/
const WRITE_QUESTIONS_TO_DB = String(process.env.WRITE_QUESTIONS_TO_DB).toLowerCase() === 'true';
const READ_QUESTIONS_FROM_DB = String(process.env.READ_QUESTIONS_FROM_DB).toLowerCase() === 'true';
const ALLOW_AI_FALLBACK = String(process.env.ALLOW_AI_FALLBACK).toLowerCase() === 'true';

if (!MODEL && !READ_QUESTIONS_FROM_DB) {
  throw new Error('OPENAI_MODEL is required in .env when READ_QUESTIONS_FROM_DB=false');
}

const sessions = new Map();

/*
  Хранит уже использованные вопросы в памяти:
  key: `${chatId}:${gameType}`
  value: Set(questionKey)
*/
const usedQuestionsByChatGame = new Map();

const GAME_TYPES = {
  FOOTBALL_QUIZ: 'football_quiz',
  FOOTBALL_QUIZ_WC: 'football_quiz_wc',
  GUESS_CLUB: 'guess_club',
  GUESS_NATIONAL_TEAM: 'guess_national_team',
  GUESS_STADIUM_BY_CLUB: 'guess_stadium_by_club'
};

const QUESTION_TABLES = {
  [GAME_TYPES.FOOTBALL_QUIZ]: 'TBL_Q_FOOTBALL_QUIZ',
  [GAME_TYPES.FOOTBALL_QUIZ_WC]: 'TBL_Q_FOOTBALL_QUIZ_WC',
  [GAME_TYPES.GUESS_CLUB]: 'TBL_Q_GUESS_CLUB',
  [GAME_TYPES.GUESS_NATIONAL_TEAM]: 'TBL_Q_GUESS_NATIONAL_TEAM',
  [GAME_TYPES.GUESS_STADIUM_BY_CLUB]: 'TBL_Q_GUESS_STADIUM_BY_CLUB'
};

const clearChatSessions = (chatId) => {
  for (const [messageId, session] of sessions.entries()) {
    if (session.chatId === chatId) {
      sessions.delete(messageId);
    }
  }
};

const getUsedKey = (chatId, gameType) => `${chatId}:${gameType}`;

const normalizeQuestionKey = (question) =>
  String(question || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const getUsedQuestionsSet = (chatId, gameType) => {
  const key = getUsedKey(chatId, gameType);

  if (!usedQuestionsByChatGame.has(key)) {
    usedQuestionsByChatGame.set(key, new Set());
  }

  return usedQuestionsByChatGame.get(key);
};

const markQuestionAsUsed = (chatId, gameType, question) => {
  const usedSet = getUsedQuestionsSet(chatId, gameType);
  usedSet.add(normalizeQuestionKey(question));
};

const hasQuestionBeenUsed = (chatId, gameType, question) => {
  const usedSet = getUsedQuestionsSet(chatId, gameType);
  return usedSet.has(normalizeQuestionKey(question));
};

const pickDifficulty = () => {
  const roll = Math.random() * 100;

  if (roll < 10) return 'лёгкая';
  if (roll < 40) return 'средняя';
  return 'высокая';
};

const buildMainMenuKeyboard = () => {
  return {
    inline_keyboard: [
      [{ text: '🎲 Выбрать игру', callback_data: 'choose_game_menu' }],
      [{ text: '🥇🥈🥉 Рейтинг игроков', callback_data: 'user_ranking' }]
    ]
  };
};

const buildGamesMenuKeyboard = () => {
  return {
    inline_keyboard: [
      [{ text: '⚽ Футбольная викторина', callback_data: GAME_TYPES.FOOTBALL_QUIZ }],
      [{ text: '🗺️ Футбольная викторина - Чемпионат мира', callback_data: GAME_TYPES.FOOTBALL_QUIZ_WC }],
      [{ text: '🏟 Угадай клуб футболиста', callback_data: GAME_TYPES.GUESS_CLUB }],
      [{ text: '🌍 Угадай сборную футболиста', callback_data: GAME_TYPES.GUESS_NATIONAL_TEAM }],
      [{ text: '🏟️ Угадай стадион по ФК', callback_data: GAME_TYPES.GUESS_STADIUM_BY_CLUB }],
      [{ text: '⬅️ Назад в главное меню', callback_data: 'main_menu' }]
    ]
  };
};

const buildRankingKeyboard = () => {
  return {
    inline_keyboard: [
      [{ text: '🔎 Найти себя', callback_data: 'find_yourself' }],
      [{ text: '⬅️ Назад в главное меню', callback_data: 'main_menu' }]
    ]
  };
};

const buildFindYourselfKeyboard = () => {
  return {
    inline_keyboard: [
      [{ text: '🥇🥈🥉 Рейтинг игроков', callback_data: 'user_ranking' }],
      [{ text: '⬅️ Назад в главное меню', callback_data: 'main_menu' }]
    ]
  };
};

const buildQuestionKeyboard = (answers) => {
  return {
    inline_keyboard: [
      ...answers.map((answer, index) => [
        {
          text: answer,
          callback_data: `answer_${index}`
        }
      ]),
      [{ text: '🎲 Выбрать игру', callback_data: 'choose_game_menu' }],
      [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
    ]
  };
};

const buildAfterAnswerKeyboard = (gameType) => {
  return {
    inline_keyboard: [
      [{ text: '➡️ Следующий вопрос', callback_data: `next_${gameType}` }],
      [{ text: '🎲 Выбрать игру', callback_data: 'choose_game_menu' }],
      [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
    ]
  };
};

const renderMainMenu = async (chatId) => {
  await bot.sendMessage(chatId, 'LF Games приветствует вас 👋', {
    reply_markup: buildMainMenuKeyboard()
  });
};

const renderGamesMenu = async (chatId) => {
  await bot.sendMessage(chatId, '🎲 Выберите игру:', {
    reply_markup: buildGamesMenuKeyboard()
  });
};

const formatRankingTable = (rows) => {
  if (!rows.length) {
    return [
      '────────────────────────────────',
      '      Рейтинг пока пуст         ',
      '────────────────────────────────'
    ].join('\n');
  }

  const lines = rows.map((user, index) => {
    const place =
      index === 0 ? '🥇' :
      index === 1 ? '🥈' :
      index === 2 ? '🥉' : `${index + 1}.`;

    const username = String(user.USERNAME || 'Без username').slice(0, 12);
    const score = String(user.SCORE ?? 0).padStart(3, ' ');
    const stats = `${user.CORRECT_ANSWERS ?? 0}/${user.TOTAL_QUESTIONS ?? 0}`.padStart(5, ' ');

    return ` ${place.padEnd(3, ' ')} ${username.padEnd(12, ' ')} │ ${score} │ ${stats} `;
  });

  return [
    '────────────────────────────────',
    ' #   Игрок         │ Счт │ ✓/Из ',
    '────────────────────────────────',
    ...lines,
    '────────────────────────────────'
  ].join('\n');
};

const renderRankingMenu = async (chatId) => {
  const result = await db.execute(
    `SELECT CHAT_ID, USERNAME, SCORE, CORRECT_ANSWERS, TOTAL_QUESTIONS
     FROM TBL_USERS
     ORDER BY SCORE DESC, CORRECT_ANSWERS DESC, TOTAL_QUESTIONS ASC`
  );

  const rankingTable = formatRankingTable(result.rows);

  await bot.sendMessage(
    chatId,
    `🥇🥈🥉 Рейтинг всех игроков\n\n${rankingTable}`,
    {
      reply_markup: buildRankingKeyboard()
    }
  );
};

const renderFindYourself = async (chatId) => {
  const result = await db.execute(
    `SELECT *
     FROM (
       SELECT
         CHAT_ID,
         USERNAME,
         SCORE,
         CORRECT_ANSWERS,
         TOTAL_QUESTIONS,
         ROW_NUMBER() OVER (
           ORDER BY SCORE DESC, CORRECT_ANSWERS DESC, TOTAL_QUESTIONS ASC
         ) AS POSITION
       FROM TBL_USERS
     )
     WHERE CHAT_ID = :chatId`,
    { chatId }
  );

  if (!result.rows.length) {
    await bot.sendMessage(
      chatId,
      '🔎 Вы пока не найдены в рейтинге.\nСыграйте хотя бы один раз.',
      {
        reply_markup: buildFindYourselfKeyboard()
      }
    );
    return;
  }

  const me = result.rows[0];
  const place =
    me.POSITION === 1 ? '🥇' :
    me.POSITION === 2 ? '🥈' :
    me.POSITION === 3 ? '🥉' : `${me.POSITION}.`;

  const username = String(me.USERNAME || 'Без username').slice(0, 12);
  const score = String(me.SCORE ?? 0).padStart(3, ' ');
  const stats = `${me.CORRECT_ANSWERS ?? 0}/${me.TOTAL_QUESTIONS ?? 0}`.padStart(5, ' ');

  const table = [
    '────────────────────────────────',
    ' #   Игрок         │ Счт │ ✓/Из ',
    '────────────────────────────────',
    ` ${place.padEnd(3, ' ')} ${username.padEnd(12, ' ')} │ ${score} │ ${stats} `,
    '────────────────────────────────'
  ].join('\n');

  await bot.sendMessage(
    chatId,
    `🔎 Ваш рейтинг\n\n${table}`,
    {
      reply_markup: buildFindYourselfKeyboard()
    }
  );
};

const getGameLabel = (gameType) => {
  switch (gameType) {
    case GAME_TYPES.FOOTBALL_QUIZ:
      return '⚽ Футбольная викторина';
    case GAME_TYPES.FOOTBALL_QUIZ_WC:
      return '⚽ Футбольная викторина - Чемпионат мира';
    case GAME_TYPES.GUESS_CLUB:
      return '🏟 Угадай клуб футболиста';
    case GAME_TYPES.GUESS_NATIONAL_TEAM:
      return '🌍 Угадай сборную футболиста';
    case GAME_TYPES.GUESS_STADIUM_BY_CLUB:
      return '🏟️ Угадай стадион по ФК';
    default:
      return '🎮 Игра';
  }
};

const getGameInstruction = (gameType) => {
  switch (gameType) {
    case GAME_TYPES.FOOTBALL_QUIZ:
      return [
        'Сгенерируй 1 вопрос футбольной викторины.',
        'Не зацикливайся на шаблонах "в каком году" и "кто выиграл".',
        'Используй разнообразные типы вопросов.',
        'Чередуй категории:',
        '- игроки',
        '- клубы',
        '- сборные',
        '- стадионы',
        '- позиции игроков',
        '- номера',
        '- тренеры',
        '- лиги и турниры',
        '- рекорды',
        '- трансферы',
        '- капитаны',
        '- дерби',
        '- домашние стадионы',
        '- страны игроков',
        '- футбольные прозвища и факты',
        'Вопросы должны быть реально разнообразными.'
      ].join(' ');
    case GAME_TYPES.FOOTBALL_QUIZ_WC:
    return [
      'Сгенерируй 1 вопрос футбольной викторины только про чемпионаты мира по футболу.',
      'Вопросы должны относиться только к турниру FIFA World Cup.',
      'Не используй клубный футбол, лиги, трансферы, дерби и несвязанные турниры.',
      'Используй разнообразные типы вопросов.',
      'Чередуй категории:',
      '- победители турниров',
      '- финалы',
      '- участники финалов',
      '- бомбардиры турниров',
      '- лучшие игроки турниров',
      '- страны-хозяйки',
      '- рекорды чемпионатов мира',
      '- игроки и сборные на чемпионатах мира',
      '- тренеры чемпионов мира',
      '- стадионы матчей чемпионатов мира',
      '- статистика матчей чемпионатов мира',
      '- известные события и факты чемпионатов мира',
      'Не зацикливайся на вопросах только про год или только про победителя.'
    ].join(' ');
    case GAME_TYPES.GUESS_CLUB:
      return [
        'Сгенерируй 1 вопрос игры "Угадай клуб футболиста".',
        'Вопрос должен быть только о текущем клубе футболиста.',
        'Используй игроков из разных лиг и стран, а не только самых медийных.',
        'Можно брать известные и среднеизвестные клубы, если факт надёжный и актуальный.'
      ].join(' ');
    case GAME_TYPES.GUESS_NATIONAL_TEAM:
      return [
        'Сгенерируй 1 вопрос игры "Угадай сборную футболиста".',
        'Вопрос должен быть только о текущей национальной сборной футболиста.',
        'Используй игроков из разных лиг и стран, а не только самых медийных.',
        'Можно брать известные и среднеизвестные сборные, если факт надёжный и актуальный.'
      ].join(' ');
    case GAME_TYPES.GUESS_STADIUM_BY_CLUB:
      return [
        'Сгенерируй 1 вопрос игры "Угадай стадион по ФК".',
        'Вопрос должен быть только о домашнем стадионе футбольного клуба.',
        'Используй клубы из разных лиг и стран, а не только топ-5 лиг.',
        'Можно брать известные и среднеизвестные клубы, если факт надёжный и актуальный.'
      ].join(' ');
    default:
      throw new Error('Unknown game type');
  }
};

const getPrompt = (gameType, difficulty, excludedQuestions = []) => {
  const excludedBlock = excludedQuestions.length
    ? [
        'Не используй и не повторяй следующие уже заданные вопросы:',
        ...excludedQuestions.map((q, i) => `${i + 1}. ${q}`)
      ].join('\n')
    : 'Старайся не повторять недавно заданные вопросы.';

  return [
    'Ты создаёшь вопросы только про футбол на русском языке.',
    getGameInstruction(gameType),
    `Сложность вопроса: ${difficulty}.`,
    'Сложность уже выбрана приложением. Строго следуй ей.',
    'Вопрос должен быть однозначным, современным и без спорных трактовок.',
    'Если вопрос про клуб, сборную или стадион, используй только известные и актуальные данные.',
    'Делай вопросы разнообразными по лигам, странам, турнирам и темам.',
    excludedBlock,
    'Верни строго JSON без markdown и без текста вне JSON.',
    'Формат JSON:',
    '{',
    '  "question": "string",',
    '  "answers": ["string", "string", "string", "string"],',
    '  "correctIndex": 0,',
    '  "explanation": "string",',
    '  "imagePrompt": "string"',
    '}',
    'Требования:',
    '- ровно 4 варианта ответа',
    '- ответы каждый раз должны быть в разброску',
    '- только 1 правильный ответ',
    '- correctIndex от 0 до 3',
    '- ответы короткие',
    '- explanation короткое, на русском',
    '- imagePrompt должен быть коротким и понятным промптом для генерации изображения по вопросу',
    '- не используй одинаковые варианты ответа',
    '- все варианты должны относиться к футболу',
    '- imagePrompt не должен содержать текст для вывода на изображении'
  ].join('\n');
};

const parseQuestionPayload = (content) => {
  const parsed = JSON.parse(content);

  if (
    !parsed ||
    typeof parsed.question !== 'string' ||
    !Array.isArray(parsed.answers) ||
    parsed.answers.length !== 4 ||
    typeof parsed.correctIndex !== 'number' ||
    parsed.correctIndex < 0 ||
    parsed.correctIndex > 3
  ) {
    throw new Error('Invalid quiz JSON structure');
  }

  return {
    question: parsed.question.trim(),
    answers: parsed.answers.map((item) => String(item).trim()),
    correctIndex: parsed.correctIndex,
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation.trim() : '',
    imagePrompt: typeof parsed.imagePrompt === 'string' ? parsed.imagePrompt.trim() : ''
  };
};

const mapDbRowToPayload = (row) => {
  return {
    question: row.QUESTION_TEXT,
    answers: [row.ANSWER_1, row.ANSWER_2, row.ANSWER_3, row.ANSWER_4],
    correctIndex: Number(row.CORRECT_INDEX),
    explanation: row.EXPLANATION || '',
    imagePrompt: row.IMAGE_PROMPT || '',
    imageUrl: row.IMG_URL || '',
    difficulty: row.DIFFICULTY || 'средняя'
  };
};

const getRecentExcludedQuestions = (chatId, gameType, limit = 15) => {
  const usedSet = getUsedQuestionsSet(chatId, gameType);
  return Array.from(usedSet).slice(-limit);
};

const fetchRandomQuestionFromDb = async (gameType, chatId) => {
  const tableName = QUESTION_TABLES[gameType];

  const result = await db.execute(
    `SELECT
      ID,
      QUESTION_TEXT,
      ANSWER_1,
      ANSWER_2,
      ANSWER_3,
      ANSWER_4,
      CORRECT_INDEX,
      EXPLANATION,
      IMAGE_PROMPT,
      IMG_URL,
      DIFFICULTY,
      SOURCE_TYPE,
      CREATED_AT
    FROM ${tableName}
    WHERE IS_ACTIVE = 1
    ORDER BY DBMS_RANDOM.VALUE`
  );

  if (!result.rows.length) {
    return {
      status: 'empty',
      payload: null
    };
  }

  const freshRow = result.rows.find(
    (row) => !hasQuestionBeenUsed(chatId, gameType, row.QUESTION_TEXT)
  );

  if (freshRow) {
    return {
      status: 'fresh',
      payload: mapDbRowToPayload(freshRow)
    };
  }

  return {
    status: 'repeat',
    payload: mapDbRowToPayload(result.rows[0])
  };
};

const saveQuestionToDb = async (gameType, payload) => {
  const tableName = QUESTION_TABLES[gameType];

  const exists = await db.execute(
    `SELECT 1
     FROM ${tableName}
     WHERE QUESTION_TEXT = :questionText`,
    { questionText: payload.question }
  );

  if (exists.rows.length > 0) {
    return;
  }

  await db.execute(
    `INSERT INTO ${tableName} (
       QUESTION_TEXT,
       ANSWER_1,
       ANSWER_2,
       ANSWER_3,
       ANSWER_4,
       CORRECT_INDEX,
       EXPLANATION,
       IMAGE_PROMPT,
       DIFFICULTY,
       SOURCE_TYPE
     ) VALUES (
       :questionText,
       :answer1,
       :answer2,
       :answer3,
       :answer4,
       :correctIndex,
       :explanation,
       :imagePrompt,
       :difficulty,
       :sourceType
     )`,
    {
      questionText: payload.question,
      answer1: payload.answers[0],
      answer2: payload.answers[1],
      answer3: payload.answers[2],
      answer4: payload.answers[3],
      correctIndex: payload.correctIndex,
      explanation: payload.explanation,
      imagePrompt: payload.imagePrompt,
      difficulty: payload.difficulty,
      sourceType: 'openai'
    }
  );
};

const generateQuestionFromOpenAI = async (gameType, chatId) => {
  const difficulty = pickDifficulty();
  const excludedQuestions = getRecentExcludedQuestions(chatId, gameType, 15);
  const prompt = getPrompt(gameType, difficulty, excludedQuestions);

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'developer',
        content: 'Ты генерируешь только валидный JSON по заданной схеме.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'football_quiz_question',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['question', 'answers', 'correctIndex', 'explanation', 'imagePrompt'],
          properties: {
            question: { type: 'string' },
            answers: {
              type: 'array',
              minItems: 4,
              maxItems: 4,
              items: { type: 'string' }
            },
            correctIndex: {
              type: 'integer',
              minimum: 0,
              maximum: 3
            },
            explanation: { type: 'string' },
            imagePrompt: { type: 'string' }
          }
        }
      }
    }
  });

  const content = response.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('OpenAI returned empty content');
  }

  const payload = parseQuestionPayload(content);
  return { ...payload, difficulty };
};

const generateUniqueOpenAIQuestion = async (gameType, chatId, attempts = 7) => {
  for (let i = 0; i < attempts; i++) {
    const payload = await generateQuestionFromOpenAI(gameType, chatId);

    if (!hasQuestionBeenUsed(chatId, gameType, payload.question)) {
      return payload;
    }
  }

  throw new Error('Не удалось сгенерировать уникальный вопрос');
};

const getQuestionPayload = async (gameType, chatId) => {
  if (READ_QUESTIONS_FROM_DB) {
    const dbResult = await fetchRandomQuestionFromDb(gameType, chatId);

    if (dbResult.status === 'fresh' && dbResult.payload) {
      return dbResult.payload;
    }

    // Таблица не пуста, но все вопросы уже были
    if (dbResult.status === 'repeat' && dbResult.payload) {
      if (!ALLOW_AI_FALLBACK) {
        return dbResult.payload; // крутим по кругу старые вопросы
      }
    }

    // Таблица пустая
    if (dbResult.status === 'empty') {
      if (!ALLOW_AI_FALLBACK) {
        return null;
      }
    }

    // Если разрешен fallback в AI
    if (ALLOW_AI_FALLBACK) {
      const payload = await generateUniqueOpenAIQuestion(gameType, chatId);

      if (WRITE_QUESTIONS_TO_DB) {
        await saveQuestionToDb(gameType, payload);
      }

      return payload;
    }

    return null;
  }

  // Если вообще не читаем из БД, работаем как раньше
  const payload = await generateUniqueOpenAIQuestion(gameType, chatId);

  if (WRITE_QUESTIONS_TO_DB) {
    await saveQuestionToDb(gameType, payload);
  }

  return payload;
};

const generateQuestionImageBuffer = async (imagePrompt, gameType) => {
  if (!ENABLE_QUESTION_IMAGES) {
    return null;
  }

  const finalPrompt = [
    `Футбольная игровая иллюстрация для режима "${getGameLabel(gameType)}".`,
    'Без текста, без логотипов, без водяных знаков.',
    'Чистая, понятная, яркая сцена, логически связанная с вопросом.',
    imagePrompt
  ].join(' ');

  const image = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt: finalPrompt,
    size: '1024x1024'
  });

  const base64 = image.data?.[0]?.b64_json;

  if (!base64) {
    return null;
  }

  return Buffer.from(base64, 'base64');
};

const sendQuestion = async (chatId, gameType) => {
  const payload = await getQuestionPayload(gameType, chatId);

  if (!payload) {
    await bot.sendMessage(
      chatId,
      `${getGameLabel(gameType)}\n\n❌ В базе пока нет доступных вопросов для этой игры.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎲 Выбрать игру', callback_data: 'choose_game_menu' }],
            [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
          ]
        }
      }
    );
    return;
  }

  markQuestionAsUsed(chatId, gameType, payload.question);

  // 👉 СНАЧАЛА пробуем отправить картинку
  try {
  // ✅ 1. Если есть IMG_URL в БД — ВСЕГДА отправляем
  if (payload.imageUrl) {
    await bot.sendPhoto(chatId, payload.imageUrl, {
      /* caption:
        `${getGameLabel(gameType)}\n` */
    });
  }

  // ✅ 2. Если нет IMG_URL — тогда уже используем AI (если включено)
  else if (ENABLE_QUESTION_IMAGES) {
    const imageBuffer = await generateQuestionImageBuffer(
      payload.imagePrompt || payload.question,
      gameType
    );

    if (imageBuffer) {
      await bot.sendPhoto(chatId, imageBuffer, {
        caption:
          `${getGameLabel(gameType)}\n`
      });
    }
  }
} catch (imageError) {
  console.error('Image sending/generation error:', imageError);
}

  // 👉 потом отправляем вопрос
  const sentMessage = await bot.sendMessage(
    chatId,
    `${getGameLabel(gameType)}\n` +
    `📊 Сложность: ${payload.difficulty}\n\n` +
    `❓ ${payload.question}`,
    {
      reply_markup: buildQuestionKeyboard(payload.answers)
    }
  );

  sessions.set(sentMessage.message_id, {
    chatId,
    gameType,
    question: payload.question,
    answers: payload.answers,
    correctIndex: payload.correctIndex,
    explanation: payload.explanation,
    difficulty: payload.difficulty,
    imagePrompt: payload.imagePrompt,
    imageUrl: payload.imageUrl || ''
  });
};

const ensureUserExists = async (chatId, username) => {
  const result = await db.execute(
    `SELECT 1 FROM TBL_USERS WHERE CHAT_ID = :chatId`,
    { chatId }
  );

  if (result.rows.length === 0) {
    await db.execute(
      `INSERT INTO TBL_USERS (CHAT_ID, USERNAME)
       VALUES (:chatId, :username)`,
      { chatId, username }
    );
  }
};

const updateUserStats = async (chatId, isCorrect) => {
  if (isCorrect) {
    await db.execute(
      `UPDATE TBL_USERS
       SET
         SCORE = SCORE + 1,
         CORRECT_ANSWERS = CORRECT_ANSWERS + 1,
         TOTAL_QUESTIONS = TOTAL_QUESTIONS + 1
       WHERE CHAT_ID = :chatId`,
      { chatId }
    );
  } else {
    await db.execute(
      `UPDATE TBL_USERS
       SET
         TOTAL_QUESTIONS = TOTAL_QUESTIONS + 1
       WHERE CHAT_ID = :chatId`,
      { chatId }
    );
  }
};

bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const username = msg.from.username || null;

    await ensureUserExists(chatId, username);
    clearChatSessions(chatId);
    await renderMainMenu(chatId);
  } catch (error) {
    console.error('START ERROR:', error);
    await bot.sendMessage(msg.chat.id, 'Ошибка при запуске. Попробуйте позже.');
  }
});

bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const sourceMessageId = query.message.message_id;

  try {
    await bot.answerCallbackQuery(query.id);

    if (data === 'main_menu') {
      clearChatSessions(chatId);
      await renderMainMenu(chatId);
      return;
    }

    if (data === 'choose_game_menu') {
      clearChatSessions(chatId);
      await renderGamesMenu(chatId);
      return;
    }

    if (data === 'user_ranking') {
      clearChatSessions(chatId);
      await renderRankingMenu(chatId);
      return;
    }

    if (data === 'find_yourself') {
      clearChatSessions(chatId);
      await renderFindYourself(chatId);
      return;
    }

    if (
      data === GAME_TYPES.FOOTBALL_QUIZ ||
      data === GAME_TYPES.FOOTBALL_QUIZ_WC ||
      data === GAME_TYPES.GUESS_CLUB ||
      data === GAME_TYPES.GUESS_NATIONAL_TEAM ||
      data === GAME_TYPES.GUESS_STADIUM_BY_CLUB
    ) {
      await bot.sendMessage(chatId, '⏳ Генерирую вопрос...');
      await sendQuestion(chatId, data);
      return;
    }

    if (data.startsWith('next_')) {
      const gameType = data.replace('next_', '');

      if (
        gameType !== GAME_TYPES.FOOTBALL_QUIZ &&
        gameType !== GAME_TYPES.FOOTBALL_QUIZ_WC &&
        gameType !== GAME_TYPES.GUESS_CLUB &&
        gameType !== GAME_TYPES.GUESS_NATIONAL_TEAM &&
        gameType !== GAME_TYPES.GUESS_STADIUM_BY_CLUB
      ) {
        return;
      }

      await bot.sendMessage(chatId, '⏳ Генерирую следующий вопрос...');
      await sendQuestion(chatId, gameType);
      return;
    }

    if (!data.startsWith('answer_')) {
      return;
    }

    const session = sessions.get(sourceMessageId);

    if (!session) {
      await bot.sendMessage(chatId, 'Сессия вопроса истекла. Выберите игру заново.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎲 Выбрать игру', callback_data: 'choose_game_menu' }],
            [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    const selectedIndex = Number(data.split('_')[1]);

    if (Number.isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex > 3) {
      return;
    }

    const isCorrect = selectedIndex === session.correctIndex;

    await updateUserStats(chatId, isCorrect);

    const selectedAnswer = session.answers[selectedIndex];
    const correctAnswer = session.answers[session.correctIndex];

    const resultText = [
      `${isCorrect ? '✅ Верно!' : '❌ Неверно!'}`,
      '',
      `🎮 Режим: ${getGameLabel(session.gameType)}`,
      `📊 Сложность: ${session.difficulty}`,
      `❓ Вопрос: ${session.question}`,
      `🟦 Ваш ответ: ${selectedAnswer}`,
      `🟩 Правильный ответ: ${correctAnswer}`,
      session.explanation ? `📘 Пояснение: ${session.explanation}` : ''
    ].filter(Boolean).join('\n');

    await bot.sendMessage(chatId, resultText, {
      reply_markup: buildAfterAnswerKeyboard(session.gameType)
    });

    sessions.delete(sourceMessageId);
  } catch (error) {
    console.error('Bot error:', error);

    await bot.sendMessage(chatId, 'Не удалось обработать действие. Попробуйте позже.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎲 Выбрать игру', callback_data: 'choose_game_menu' }],
          [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
        ]
      }
    });
  }
});