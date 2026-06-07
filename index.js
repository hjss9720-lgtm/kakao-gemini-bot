const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());

// 주머니(캐시): 사용자ID를 키로 해서 '최신 상태'를 저장
const userSession = new Map(); 

const G_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash-lite";

// 1. 브라우저 접속 확인용 (GET /)
app.get("/", (req, res) => {
  res.send("Vercel Gemini Bot is Active! 🚀");
});

// 2. 카카오톡 챗봇 연동용 웹훅 (POST /webhook)
app.post("/webhook", async (req, res) => {
  const userId = req.body.userRequest?.user?.id || "unknown";
  const userMsg = req.body.userRequest?.utterance || "";
  
  // 주머니 확인
  const session = userSession.get(userId);

  // 답변이 완성된 상태라면 즉시 반환
  if (session && session.status === "COMPLETED") {
    const finalReply = session.reply;
    userSession.delete(userId); 
    return res.json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: finalReply } }] }
    });
  }

  // 만드는 중(PENDING)이라면 안내 멘트
  if (session && session.status === "PENDING") {
    return res.json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: "아직 열심히 정리 중이에요! 3초만 더 기다렸다가 '답 나왔어?'라고 물어봐 주세요. 🏃‍♂️" } }] }
    });
  }

  // 새로운 질문 접수
  userSession.set(userId, { status: "PENDING", lastMsg: userMsg });
  runGemini(userId, userMsg);

  // 첫 질문 시 4초 대기
  const result = await Promise.race([
    waitForReply(userId),
    new Promise(resolve => setTimeout(() => resolve("TIMEOUT"), 4000))
  ]);

  if (result !== "TIMEOUT" && result !== "ERROR") {
    userSession.delete(userId);
    return res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: result } }] } });
  } else {
    return res.json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: "내용이 좀 길어서 생각할 시간이 필요해요. 잠시 후 '결과 알려줘'라고 말씀해 주세요! 😊" } }] }
    });
  }
});

async function waitForReply(uid) {
  while (true) {
    const session = userSession.get(uid);
    if (session && session.status === "COMPLETED") return session.reply;
    if (!session) return "ERROR";
    await new Promise(r => setTimeout(r, 500));
  }
}

async function runGemini(uid, msg) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${G_KEY}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: msg }] }],
        generationConfig: { maxOutputTokens: 600, temperature: 0.7 }
      })
    });
    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    
    if (reply) {
      userSession.set(uid, { status: "COMPLETED", reply: reply });
      setTimeout(() => userSession.delete(uid), 300000); // 5분 후 폭파
    } else {
      userSession.delete(uid);
    }
  } catch (e) {
    userSession.delete(uid);
  }
}

module.exports = app;
