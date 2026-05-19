const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());

// 주머니(캐시): 사용자ID를 키로 해서 '최신 상태'를 저장
const userSession = new Map(); 

const G_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash-lite";

app.post("/webhook", async (req, res) => {
  const userId = req.body.userRequest?.user?.id || "unknown";
  const userMsg = req.body.userRequest?.utterance || "";
  
  // 1. 주머니 확인
  const session = userSession.get(userId);

  // 2. 만약 답변이 완성된 상태라면? 사용자가 뭐라고 묻든(예: "답 줘", "ㅎㅇ") 바로 답변 투척!
  if (session && session.status === "COMPLETED") {
    const finalReply = session.reply;
    userSession.delete(userId); // 답 줬으니까 주머니 비우기
    return res.json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: finalReply } }] }
    });
  }

  // 3. 만약 아직 만드는 중(PENDING)이라면?
  if (session && session.status === "PENDING") {
    return res.json({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: "아직 열심히 정리 중이에요! 3초만 더 기다렸다가 '답 나왔어?'라고 물어봐 주세요. 🏃‍♂️" } }] }
    });
  }

  // 4. 완전히 새로운 질문인 경우
  userSession.set(userId, { status: "PENDING", lastMsg: userMsg });
  
  // 백그라운드에서 제미나이 가동
  runGemini(userId, userMsg);

  // 첫 질문 시 딱 4초만 기다려봄
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
      // 5분 뒤 자동 삭제 (안 물어보고 나가는 경우 대비)
      setTimeout(() => userSession.delete(uid), 300000);
    } else {
      userSession.delete(uid);
    }
  } catch (e) {
    userSession.delete(uid);
  }
}

module.exports = app;
