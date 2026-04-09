const TelegramBot = require('node-telegram-bot-api');
const he = require('he');
require('dotenv').config();
const db = require('./db');

(async () => {
  try {
    const result = await db.execute(`SELECT 1 AS TEST FROM DUAL`);
    console.log(result.rows);
  } catch (e) {
    console.error(e);
  }
})();


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
  const res = await fetch('https://opentdb.com/api.php?amount=1&type=multiple&category=15');

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
      [{ text: '🎮 Choose game', callback_data: 'choose_game_menu' }],
      [{ text: '🏆 User ranking', callback_data: 'user_ranking' }]
    ]
  };
};

const buildGamesMenuKeyboard = () => {
  return {
    inline_keyboard: [
      [{ text: '🎮 Game 1', callback_data: 'game1' }],
      [{ text: '⬅️ Back to main menu', callback_data: 'main_menu' }]
    ]
  };
};

const buildRankingKeyboard = () => {
  return {
    inline_keyboard: [
      [{ text: '🏆 Top players', callback_data: 'top_players' }],
      [{ text: '🔎 Find yourself', callback_data: 'find_yourself' }],
      [{ text: '⬅️ Back to main menu', callback_data: 'main_menu' }]
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
      [{ text: '🎮 Choose game', callback_data: 'choose_game_menu' }],
      [{ text: '🏠 Main menu', callback_data: 'main_menu' }]
    ]
  };
};

const renderMainMenu = async (chatId, messageId = null) => {
  const text = 'HI 👋\nChoose an option:';

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
  await bot.editMessageText('🎮 Choose a game:', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: buildGamesMenuKeyboard()
  });
};

const renderRankingMenu = async (chatId, messageId) => {
  await bot.editMessageText('🏆 User ranking\n\nChoose an option:', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: buildRankingKeyboard()
  });
};

const loadAndRenderQuestion = async (chatId, messageId) => {
  const quiz = await getQuiz();

  const decodedQuestion = he.decode(quiz.question);
  const correctAnswer = he.decode(quiz.correct_answer);
  const incorrectAnswers = quiz.incorrect_answers.map((item) => he.decode(item));

  const answers = shuffleArray([correctAnswer, ...incorrectAnswers]);
  const correctIndex = answers.findIndex((item) => item === correctAnswer);

  sessions.set(chatId, {
    question: decodedQuestion,
    answers,
    correctIndex
  });

  await bot.editMessageText(`❓ ${decodedQuestion}`, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: buildQuestionKeyboard(answers)
  });
};

bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const username = msg.from.username || null;

    console.log('START:', { chatId, username });

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

      console.log('User created');
    } else {
      console.log('User already exists');
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

      case 'top_players':
        await bot.editMessageText(
          '🏆 Top players\n\n1. PlayerOne — 120 pts\n2. Murad — 95 pts\n3. QuizMaster — 80 pts',
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: buildRankingKeyboard()
          }
        );
        break;

      case 'find_yourself':
        await bot.editMessageText(
          '🔎 Find yourself\n\nYour current rank: #2\nYour score: 95 pts',
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: buildRankingKeyboard()
          }
        );
        break;

      case 'game1':
        await bot.editMessageText('Loading quiz...', {
          chat_id: chatId,
          message_id: messageId
        });
        await loadAndRenderQuestion(chatId, messageId);
        break;

      case 'next_question':
        await bot.editMessageText('Loading next question...', {
          chat_id: chatId,
          message_id: messageId
        });
        await loadAndRenderQuestion(chatId, messageId);
        break;

      default:
        if (data.startsWith('answer_')) {
          const session = sessions.get(chatId);

          if (!session) {
            await bot.editMessageText('Session expired. Please start again.', {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🏠 Main menu', callback_data: 'main_menu' }]
                ]
              }
            });
            return;
          }

          const selectedIndex = Number(data.split('_')[1]);
          const isCorrect = selectedIndex === session.correctIndex;

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
            `${isCorrect ? '✅ Correct!' : '❌ Wrong!'}\n\n❓ ${session.question}`,
            {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: {
                inline_keyboard: [
                  ...answeredButtons,
                  [{ text: '➡️ Next question', callback_data: 'next_question' }],
                  [{ text: '🎮 Choose game', callback_data: 'choose_game_menu' }],
                  [{ text: '🏠 Main menu', callback_data: 'main_menu' }]
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
      await bot.editMessageText('Failed to fetch quiz data. Please try again later.', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎮 Choose game', callback_data: 'choose_game_menu' }],
            [{ text: '🏠 Main menu', callback_data: 'main_menu' }]
          ]
        }
      });
    } catch {
      await bot.sendMessage(chatId, 'Failed to fetch quiz data. Please try again later.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎮 Choose game', callback_data: 'choose_game_menu' }],
            [{ text: '🏠 Main menu', callback_data: 'main_menu' }]
          ]
        }
      });
    }
  }
});