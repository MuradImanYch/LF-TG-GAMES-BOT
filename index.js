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

if (!MODEL) {
  throw new Error('OPENAI_MODEL is required in .env');
}

const sessions = new Map();

const GAME_TYPES = {
  FOOTBALL_QUIZ: 'football_quiz',
  GUESS_CLUB: 'guess_club',
  GUESS_NATIONAL_TEAM: 'guess_national_team',
  GUESS_STADIUM_BY_CLUB: 'guess_stadium_by_club'
};

const clearChatSessions = (chatId) => {
  for (const [messageId, session] of sessions.entries()) {
    if (session.chatId === chatId) {
      sessions.delete(messageId);
    }
  }
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
      return 'Сгенерируй 1 вопрос футбольной викторины. Вопрос должен быть только о футболе.';
    case GAME_TYPES.GUESS_CLUB:
      return 'Сгенерируй 1 вопрос игры "Угадай клуб футболиста". Вопрос должен быть только о текущем клубе футболиста.';
    case GAME_TYPES.GUESS_NATIONAL_TEAM:
      return 'Сгенерируй 1 вопрос игры "Угадай сборную футболиста". Вопрос должен быть только о текущей национальной сборной футболиста.';
    case GAME_TYPES.GUESS_STADIUM_BY_CLUB:
      return 'Сгенерируй 1 вопрос игры "Угадай стадион по ФК". Вопрос должен быть только о домашнем стадионе футбольного клуба.';
    default:
      throw new Error('Unknown game type');
  }
};

const getPrompt = (gameType, difficulty) => {
  return [
    'Ты создаёшь вопросы только про футбол на русском языке.',
    getGameInstruction(gameType),
    `Сложность вопроса: ${difficulty}.`,
    'Сложность уже выбрана приложением. Строго следуй ей.',
    'Вопрос должен быть однозначным, современным и без спорных трактовок.',
    'Если вопрос про клуб, сборную или стадион, используй только известные и актуальные данные.',
    'Задавай вопросы из разных лиг, старайся более разнообразные вопросы задавать.',
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
    '- imagePrompt должен быть коротким и понятным промптом для генерации изображения для данного вопроса, логически связанного с вопросом а не какая то абстрактная красивая картинка, если это личность то сгененрируй её или его портрет, если это клуб то сгенерируй его логотип, если сборная то её флаг, если стадион то его вид, не используй в imagePrompt текст который нужно вывести на изображении',
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

const generateQuestionFromOpenAI = async (gameType) => {
  const difficulty = pickDifficulty();
  const prompt = getPrompt(gameType, difficulty);

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

const generateQuestionImageBuffer = async (imagePrompt, gameType) => {
  if (!ENABLE_QUESTION_IMAGES) {
    return null;
  }

  const finalPrompt = [
    `Футбольная игровая иллюстрация для режима "${getGameLabel(gameType)}".`,
    'Без текста, без логотипов, без водяных знаков, без коллажей из букв.',
    'Чистая, понятная, яркая сцена, которая помогает визуально понять вопрос.',
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
  const payload = await generateQuestionFromOpenAI(gameType);

  if (ENABLE_QUESTION_IMAGES) {
    try {
      const imageBuffer = await generateQuestionImageBuffer(payload.imagePrompt || payload.question, gameType);

      if (imageBuffer) {
        await bot.sendPhoto(chatId, imageBuffer, {
          caption: `${getGameLabel(gameType)}\n📊 Сложность: ${payload.difficulty}\n🖼 Визуальная подсказка`
        });
      }
    } catch (imageError) {
      console.error('Image generation error:', imageError);
    }
  }

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
    imagePrompt: payload.imagePrompt
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