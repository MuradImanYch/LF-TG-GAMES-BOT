const TelegramBot = require('node-telegram-bot-api');
const he = require('he');
require('dotenv').config();
const db = require('./db');
const translate = require('translate-google');

const translateText = async (text) => {
  try {
    const res = await translate(text, { from: 'en', to: 'ru' });
    return res;
  } catch (e) {
    console.error('Translate error:', e);
    return text;
  }
};

/* const getPlayers = async () => {
  const res = await fetch('https://api.football-data.org/v4/persons/44', {
    headers: {
      'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY
    }
  });

  const data = await res.json();
};

getPlayers(); */

const token = process.env.TG_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const sessions = new Map();

const shuffleArray = (arr) => {
  const copy = [...arr];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
};

const getQuiz = async () => {
  const res = await fetch('https://opentdb.com/api.php?amount=1&type=multiple&category=21');

  if (!res.ok) {
    throw new Error(`HTTP error: ${res.status}`);
  }

  const data = await res.json();

  if (!data.results || !data.results.length) {
    throw new Error('Quiz data is empty');
  }

  return data.results[0];
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
      [{ text: '🤾🏈 Спортивная викторина', callback_data: 'sport_quiz' }],
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

const renderMainMenu = async (chatId, messageId = null) => {
  const text = 'LF Games приветствует вас 👋';

  if (messageId) {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: buildMainMenuKeyboard()
    });
  } else {
    await bot.sendMessage(chatId, text, {
      reply_markup: buildMainMenuKeyboard()
    });
  }
};

const renderGamesMenu = async (chatId, messageId) => {
  await bot.editMessageText('🎲 Выберите игру:', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: buildGamesMenuKeyboard()
  });
};

const formatRankingTable = (rows) => {
  if (!rows.length) {
    return [
      '──────────────────────────────',
      '      Рейтинг пока пуст       ',
      '──────────────────────────────'
    ].join('\n');
  }

  const topRows = rows;

  const lines = topRows.map((user, index) => {
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

const renderRankingMenu = async (chatId, messageId) => {
  const result = await db.execute(
    `SELECT CHAT_ID, USERNAME, SCORE, CORRECT_ANSWERS, TOTAL_QUESTIONS
     FROM TBL_USERS
     ORDER BY SCORE DESC, CORRECT_ANSWERS DESC, TOTAL_QUESTIONS ASC`
  );

  const rankingTable = formatRankingTable(result.rows);

  await bot.editMessageText(
    `🥇🥈🥉 Рейтинг всех игроков\n\n<code>${rankingTable}</code>`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: buildRankingKeyboard()
    }
  );
};

const renderFindYourself = async (chatId, messageId) => {
  const result = await db.execute(
    `SELECT CHAT_ID, USERNAME, SCORE, CORRECT_ANSWERS, TOTAL_QUESTIONS
     FROM TBL_USERS
     ORDER BY SCORE DESC, CORRECT_ANSWERS DESC, TOTAL_QUESTIONS ASC`
  );

  const rows = result.rows;
  const myIndex = rows.findIndex((user) => Number(user.CHAT_ID) === Number(chatId));

  if (myIndex === -1) {
    await bot.editMessageText(
      '🔎 Вы пока не найдены в рейтинге.\nСыграйте хотя бы один раз.',
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buildFindYourselfKeyboard()
      }
    );
    return;
  }

  const lines = rows.map((user, index) => {
    const place =
      index === 0 ? '🥇' :
      index === 1 ? '🥈' :
      index === 2 ? '🥉' : `${index + 1}.`;

    const username = String(user.USERNAME || 'Без username').slice(0, 12);
    const score = String(user.SCORE ?? 0).padStart(3, ' ');
    const stats = `${user.CORRECT_ANSWERS ?? 0}/${user.TOTAL_QUESTIONS ?? 0}`.padStart(5, ' ');

    const isMe = Number(user.CHAT_ID) === Number(chatId);

    return ` ${place.padEnd(3, ' ')} ${username.padEnd(12, ' ')} │ ${score} │ ${stats} `;
  });

  const table = [
    '────────────────────────────────',
    ' #   Игрок         │ Счт │ ✓/Из ',
    '────────────────────────────────',
    ...lines,
    '────────────────────────────────'
  ].join('\n');

  await bot.editMessageText(
    `🔎 Ваш рейтинг\n\n<code>${table}</code>`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: buildFindYourselfKeyboard()
    }
  );
};

const loadAndRenderQuestion = async (chatId, messageId) => {
  const quiz = await getQuiz();

  const decodedQuestion = he.decode(quiz.question);
  const translatedQuestion = await translateText(decodedQuestion);

  const decodedCorrectAnswer = he.decode(quiz.correct_answer);
  const correctAnswer = await translateText(decodedCorrectAnswer);

  const incorrectAnswers = await Promise.all(
    quiz.incorrect_answers.map(async (item) => {
      const decoded = he.decode(item);
      return await translateText(decoded);
    })
  );

  const answers = shuffleArray([correctAnswer, ...incorrectAnswers]);
  const correctIndex = answers.findIndex((item) => item === correctAnswer);

  sessions.set(chatId, {
    question: translatedQuestion,
    answers,
    correctIndex
  });

  await bot.editMessageText(`❓ ${translatedQuestion}`, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: buildQuestionKeyboard(answers)
  });
};

bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const username = msg.from.username || null;

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

    sessions.delete(chatId);
    await renderMainMenu(chatId);
  } catch (error) {
    console.error('START ERROR:', error);
  }
});

bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    await bot.answerCallbackQuery(query.id);

    switch (data) {
      case 'main_menu':
        sessions.delete(chatId);
        await renderMainMenu(chatId, messageId);
        break;

      case 'choose_game_menu':
        sessions.delete(chatId);
        await renderGamesMenu(chatId, messageId);
        break;

      case 'user_ranking':
        sessions.delete(chatId);
        await renderRankingMenu(chatId, messageId);
        break;

      case 'find_yourself':
        sessions.delete(chatId);
        await renderFindYourself(chatId, messageId);
        break;

      case 'sport_quiz':
        await bot.editMessageText('Загрузка вопросов...', {
          chat_id: chatId,
          message_id: messageId
        });
        await loadAndRenderQuestion(chatId, messageId);
        break;

      case 'next_question':
        await bot.editMessageText('Загрузка следующего вопроса...', {
          chat_id: chatId,
          message_id: messageId
        });
        await loadAndRenderQuestion(chatId, messageId);
        break;

      default:
        if (data.startsWith('answer_')) {
          const session = sessions.get(chatId);

          if (!session) {
            await bot.editMessageText('Сессия истекла. Пожалуйста, начните заново.', {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
              }
            });
            return;
          }

          const selectedIndex = Number(data.split('_')[1]);
          const isCorrect = selectedIndex === session.correctIndex;

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

          const answeredButtons = session.answers.map((answer, index) => {
            let prefix = '▫️';

            if (index === session.correctIndex) {
              prefix = '✅';
            } else if (index === selectedIndex && !isCorrect) {
              prefix = '❌';
            }

            return [
              {
                text: `${prefix} ${answer}`,
                callback_data: 'disabled'
              }
            ];
          });

          await bot.editMessageText(
            `${isCorrect ? '✅ Верно!' : '❌ Неверно!'}\n\n❓ ${session.question}`,
            {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: {
                inline_keyboard: [
                  ...answeredButtons,
                  [{ text: '➡️ Следующий вопрос', callback_data: 'next_question' }],
                  [{ text: '🎲 Выбрать игру', callback_data: 'choose_game_menu' }],
                  [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
              }
            }
          );
        }
        break;
    }
  } catch (error) {
    console.error('Bot error:', error);

    try {
      await bot.editMessageText('Не удалось загрузить данные викторины. Пожалуйста, попробуйте позже.', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎲 Выбрать игру', callback_data: 'choose_game_menu' }],
            [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
          ]
        }
      });
    } catch {
      await bot.sendMessage(chatId, 'Не удалось загрузить данные викторины. Пожалуйста, попробуйте позже.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎲 Выбрать игру', callback_data: 'choose_game_menu' }],
            [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
          ]
        }
      });
    }
  }
});