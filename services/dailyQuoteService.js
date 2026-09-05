const { GoogleGenAI } = require('@google/genai');
const User = require('../models/User');
const firebaseNotificationService = require('./firebaseNotificationService');

// NOTE: Ensure process.env.GEMINI_API_KEY is set in the server environment (.env file)
const apiKey = process.env.GEMINI_API_KEY || 'MISSING_API_KEY';
const ai = new GoogleGenAI({ apiKey });

// --- FALLBACK SCHEDULE ---
const defaultSchedule = {
  monday: {
    morning: "Happy Monday! Let's set our goals for the week and start strong. 🚀",
    evening: "Great job getting through Monday. Time to disconnect and recharge. 🔋"
  },
  tuesday: {
    morning: "Good morning! Let's focus up and have a highly productive Tuesday. 🎯",
    evening: "Work is done! Remember to stretch and step away from the screens. 🛑"
  },
  wednesday: {
    morning: "Happy Hump Day! We are halfway through the week. Keep up the momentum! ✨",
    evening: "Take a deep breath. Reflect on one good thing that happened today. 🧘"
  },
  thursday: {
    morning: "Good morning! Let's crush today's tasks and prepare for a great end to the week. 💪",
    evening: "The week is almost over! Jot down your priorities for tomorrow so you can relax tonight. 📝"
  },
  friday: {
    morning: "Happy Friday! Let's finish the week strong so we can enjoy the weekend. 🎉",
    evening: "You made it! Close those laptops, celebrate the week's wins, and have a fantastic weekend! 🥂"
  },
  saturday: {
    morning: "Good morning! Take some time for yourself today. Enjoy your weekend! ☀️",
    evening: "Unplug completely and enjoy your evening with friends and family. 🌙"
  },
  sunday: {
    morning: "Happy Sunday! Use today to rest and do whatever brings you joy. ☕",
    evening: "The weekend is wrapping up. Take a quick 10 minutes to plan your Monday! 📅"
  }
};

async function getDailyNotification(timeOfDay) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const currentDayStr = days[new Date().getDay()]; 

  try {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY is not set in environment.");
    }

    let prompt = "";
    if (timeOfDay === 'morning') {
      prompt = `You are an HR manager. Write a short, highly unique, and inspiring morning push notification (max 2 sentences) for a company's employees on a ${currentDayStr} morning. Make it energetic, do not use cliches, and include one relevant emoji.`;
    } else {
      prompt = `You are an HR manager. Write a short, highly unique evening push notification (max 2 sentences) for a company's employees on a ${currentDayStr} evening. Remind them to log off, relax, and disconnect. Include one relevant emoji.`;
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        temperature: 0.8, 
      }
    });

    const notificationText = response.text.trim();
    console.log(`[DailyQuoteService] Generated from Gemini for ${timeOfDay}:`, notificationText);
    return notificationText;

  } catch (error) {
    console.error("[DailyQuoteService] Gemini API Failed. Falling back to default quote.", error.message);
    const fallbackText = defaultSchedule[currentDayStr][timeOfDay];
    return fallbackText;
  }
}

async function sendCompanyWideQuote(timeOfDay) {
    try {
        console.log(`[DailyQuoteService] Initiating company-wide ${timeOfDay} quote...`);
        const messageBody = await getDailyNotification(timeOfDay);

        // Fetch all active users with an FCM token
        const users = await User.find({ status: "Active" }).select("_id").lean();
        const userIds = users.map(u => String(u._id));

        if (userIds.length === 0) {
            console.log("[DailyQuoteService] No active users found to send quote to.");
            return;
        }

        const payload = {
            title: timeOfDay === 'morning' ? "Morning Motivation" : "Evening Wind-Down",
            body: messageBody,
            data: {
                type: "daily_quote",
                timeOfDay: timeOfDay
            }
        };

        const result = await firebaseNotificationService.sendToUsers(userIds, payload);
        console.log(`[DailyQuoteService] Finished sending. Result:`, result);

    } catch (err) {
        console.error("[DailyQuoteService] Error sending company wide quote:", err.message);
    }
}

module.exports = {
    sendCompanyWideQuote
};
