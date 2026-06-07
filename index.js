const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const app = express();
app.use(express.json());

// 사용자 세션 캐시
const userSession = new Map();

const G_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.0-flash"; // 2.5-flash-lite보다 빠름

const SYSTEM_PROMPT = `당신은 친절한 한중에스에스 고객 상담 챗봇입니다.
답변 규칙:
- 반드시 3문장 이내로 짧게 답변
- 불필요한 인사말/마무리 멘트 금지
- 핵심만 간결하게`;

// GET / - 서버 상태 확인
app.get("/", (req, res) => {
  res.send("Vercel Gemini Bot is Active! 🚀");
});

// POST /webhook - 카카오톡 챗봇 웹훅
app.post("/webhook", async (req, res) => {
  const userId = req.body.userRequest?.user?.id || "unknown";
  const userMsg = req.body.userRequest?.utterance || "";

  const session = userSession.get(userId);

  // 답변 완성된 경우 → 즉시 반환
  if (session?.status === "COMPLETED") {
    const finalReply = session.reply;
    userSession.delete(userId);
    return res.json(kakaoResponse(finalReply));
  }

  // 아직 생성 중인 경우
  if (session?.status === "PENDING") {
    return res.json(kakaoResponse("아직 답변 생성 중이에요! 잠시 후 다시 말씀해 주세요 🏃"));
  }

  // 새 질문 → 세션 등록 후 Gemini 호출 시작
  userSession.set(userId, { status: "PENDING", lastMsg: userMsg });
  runGemini(userId, userMsg);

  // 최대 4.5초 대기 (카카오 5초 제한 직전까지)
  const result = await Promise.race([
    waitForReply(userId),
    new Promise(resolve => setTimeout(() => resolve("TIMEOUT"), 4500))
  ]);

  if (result !== "TIMEOUT" && result !== "ERROR") {
    userSession.delete(userId);
    return res.json(kakaoResponse(result));
  }

  // 타임아웃 → 안내 메시지
  return res.json(kakaoResponse("답변을 정리하는 중이에요! 잠시 후 다시 말씀해 주세요 😊"));
});

// 세션에서 완료 대기 (폴링)
async function waitForReply(uid) {
  while (true) {
    const session = userSession.get(uid);
    if (!session) return "ERROR";
    if (session.status === "COMPLETED") return session.reply;
    await new Promise(r => setTimeout(r, 300)); // 0.3초마다 체크
  }
}

// Gemini API 호출
async function runGemini(uid, msg) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${G_KEY}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents: [{ parts: [{ text: msg }] }],
        generationConfig: {
          maxOutputTokens: 300, // 짧게 제한
          temperature: 0.5      // 낮출수록 빠르고 일관된 답변
        }
      })
    });

    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (reply) {
      userSession.set(uid, { status: "COMPLETED", reply });
      setTimeout(() => userSession.delete(uid), 180000); // 3분 후 자동 삭제
    } else {
      userSession.delete(uid);
    }
  } catch (e) {
    console.error("Gemini error:", e);
    userSession.delete(uid);
  }
}

// 카카오 응답 포맷
function kakaoResponse(text) {
  return {
    version: "2.0",
    template: { outputs: [{ simpleText: { text } }] }
  };
}

module.exports = app;
