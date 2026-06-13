const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const app = express();
app.use(express.json());

// 사용자 세션 캐시
const userSession = new Map();

const G_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const MODEL = "gemini-2.0-flash";
const EMBED_MODEL = "models/gemini-embedding-001";

// GET / - 서버 상태 확인
app.get("/", (req, res) => {
  res.send("Vercel Gemini RAG Bot is Active! 🚀");
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

  // 새 질문 → 세션 등록 후 RAG+Gemini 호출 시작
  userSession.set(userId, { status: "PENDING", lastMsg: userMsg });
  runRAGGemini(userId, userMsg);

  // 최대 4.5초 대기
  const result = await Promise.race([
    waitForReply(userId),
    new Promise(resolve => setTimeout(() => resolve("TIMEOUT"), 4500))
  ]);

  if (result !== "TIMEOUT" && result !== "ERROR") {
    userSession.delete(userId);
    return res.json(kakaoResponse(result));
  }

  return res.json(kakaoResponse("답변을 정리하는 중이에요! 잠시 후 다시 말씀해 주세요 😊"));
});

// 세션 완료 대기
async function waitForReply(uid) {
  while (true) {
    const session = userSession.get(uid);
    if (!session) return "ERROR";
    if (session.status === "COMPLETED") return session.reply;
    await new Promise(r => setTimeout(r, 300));
  }
}

// 1. 질문을 임베딩으로 변환
async function getEmbedding(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/${EMBED_MODEL}:embedContent?key=${G_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_QUERY"
    })
  });
  const data = await res.json();
  return data.embedding?.values || null;
}

// 2. Supabase에서 유사한 FAQ 검색
async function searchFAQ(embedding) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_faq`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_threshold: 0.5,
      match_count: 3
    })
  });
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// 3. RAG + Gemini 답변 생성
async function runRAGGemini(uid, msg) {
  try {
    // 임베딩 생성
    const embedding = await getEmbedding(msg);

    let contextText = "";
    if (embedding) {
      const matches = await searchFAQ(embedding);
      if (matches.length > 0) {
        contextText = matches
          .map(m => `Q: ${m.question}\nA: ${m.answer}`)
          .join("\n\n");
      }
    }

    // 시스템 프롬프트 구성
    const systemPrompt = `당신은 한중에스에스 고객 상담 챗봇입니다.
답변 규칙:
- 반드시 3문장 이내로 짧고 명확하게 답변
- 불필요한 인사말/마무리 멘트 금지
- 아래 회사 자료가 있으면 우선 참고하고, 없으면 일반 지식으로 답변

[회사 자료]
${contextText || "관련 자료 없음"}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${G_KEY}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: msg }] }],
        generationConfig: {
          maxOutputTokens: 300,
          temperature: 0.5
        }
      })
    });

    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (reply) {
      userSession.set(uid, { status: "COMPLETED", reply });
      setTimeout(() => userSession.delete(uid), 180000);
    } else {
      userSession.delete(uid);
    }
  } catch (e) {
    console.error("RAG error:", e);
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
