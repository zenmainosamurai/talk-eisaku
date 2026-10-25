// AIコーチへの指示文。アプリを更新しなくても、ここを直してデプロイすれば中身を変えられる
export type Line = { who: string; text: string };
export type Context = { before?: Line[]; after?: Line[] } | null;
export type CoachRequest = {
  kind: "teach" | "grade" | "ping";
  ja?: string;
  answer?: string;
  ref?: string;
  level?: string;
  context?: Context;
};

const LEVELS: Record<string, string> = {
  beginner: "The learner is a BEGINNER (about CEFR A1-A2). Worth practicing: short everyday messages that teach basic, high-frequency English (thanks, plans, feelings, simple questions and reactions). Not worth it: messages whose natural English needs advanced vocabulary or idioms, or that depend on niche jargon.",
  intermediate: "The learner is INTERMEDIATE (about CEFR B1-B2). Worth practicing: everyday messages with something to learn (a common expression, a useful structure, natural phrasing they could reuse). Not worth it: bare acknowledgements or reactions with nothing to learn (OK, I see, thanks), and messages too specialized to be useful.",
  advanced: "The learner is ADVANCED (about CEFR C1 or above). Worth practicing: messages whose natural English needs nuance, idioms, the right tone or phrasing a strong learner might still get wrong. Not worth it: anything a capable learner can already say easily (basic greetings, thanks, simple facts or simple questions)."
};

const clip = (s: unknown, n: number) => Array.from(String(s ?? "")).slice(0, n).join("").replace(/<<<|>>>/g, "");
const WHO = /^(Me|Friend( [B-Z])?)$/;

function contextBlock(ja: string, ctx: Context): string {
  if (!ctx) return "";
  const fix = (arr: Line[] | undefined) => (Array.isArray(arr) ? arr : []).slice(0, 3)
    .map(l => ({ who: WHO.test(String(l?.who)) ? String(l.who) : "Friend", text: clip(l?.text, 200) }))
    .filter(l => l.text);
  const before = fix(ctx.before), after = fix(ctx.after);
  if (!before.length && !after.length) return "";
  const lines = [...before.map(l => `${l.who}: ${l.text}`), `>>> Me: ${ja}    <- THE MESSAGE TO WORK ON`, ...after.map(l => `${l.who}: ${l.text}`)];
  return "This message comes from a LINE chat ([写真] = a photo, [スタンプ] = a sticker). The surrounding messages are for understanding only; do not translate them:\n<<<\n" + lines.join("\n") + "\n>>>\nUse this context to get pronouns, tense, tone and implied meaning right. The English must make sense as the message at that point in this conversation.\n\n";
}

// 会話の相手の名前（LINE の表示名）は端末から送らない（2026年10月、利用者の判断）。
// そのため、発言の中の名前が会話の相手かどうかは、発言と前後のやり取りから AI に判断させる。
// 日本語では、相手に直接「田中は明日来られそう？」のように名前で話しかけることがあるので、相手なら you にする
const NAMES_RULE = "Names: this is a LINE message sent to the person or people in the chat, and their names are not given to you. Japanese often uses the name of the person you are talking to where English uses \"you\": to call them (山田君、 or たっくん at the start of the message), and also as the subject or object of the sentence (田中は明日来られそう？ said to 田中 means Can you come tomorrow?). For each name in the message, decide from the message and the surrounding messages whether it is the person the message is sent to (for example, the friend's reply answers the question about that person in the first person). If it is, say \"you\" in English and make the rest of the sentence match, or leave out a name used only to get their attention. If it is clearly an affectionate pet name between close people, you may use a natural English term of endearment instead (honey or babe for a romantic partner, buddy for a close friend). If the name is someone else, or you cannot tell, write it in romaji. This applies to the model answer, the alternatives and the natural version.\n\n";

// 利用者は誰に送ったかを知っているので、名前を you などの人称に変えた回答は、その判断を正しいものとして扱う
const PRONOUN_OK = "If the learner replaced a person's name in the Japanese with a pronoun (you, he, she, they and so on), assume they did it on purpose because they know who the message was about: count that part as correct even if the model answer uses the name, and do not mention it in feedback, natural or natural_why. For example, for 田中は明日来られそう？ the attempt Can you come tomorrow? is correct.";

const SPOKEN = [
  "1. model: the most natural casual English a native speaker would say to a friend with the same meaning and tone, as if saying this message out loud. Keep it short. This app is for SPEAKING practice, so write only words that are actually pronounced: no lol, lmao, haha, emoji, emoticons or other text-only markers, and spell out texting abbreviations (by the way, not btw; I don't know, not idk). Do not translate 笑 / (笑) / w or stickers; if the laugh carries meaning, convey it with spoken words instead (for example I'm kidding, or that's hilarious). Write any Japanese name you keep in romaji (see Names above).",
  "2. alts: 1-2 other natural ways to say it, worded differently, following the same speaking-only rule."
];

export function buildTeachPrompt(req: CoachRequest): string {
  const ja = clip(req.ja, 400);
  const level = LEVELS[String(req.level)] ? String(req.level) : "intermediate";
  return [
    "You are an English coach for a Japanese adult. They learn to SAY their OWN real LINE messages (casual texts to a friend) out loud in natural spoken English.",
    "",
    NAMES_RULE + contextBlock(ja, req.context ?? null) + "Japanese message they actually sent:",
    "<<<" + ja + ">>>",
    "",
    "First decide whether this message is worth practicing for this learner.",
    LEVELS[level],
    "At every level, NOT worth practicing: a fragment with no clear meaning on its own even with the context, a lone name, nickname or noun, an inside joke or wordplay that only works in Japanese, gibberish, ASCII art, or a message that is mostly numbers or symbols.",
    "When in doubt, treat it as worth practicing. Do not skip a message only because it is short.",
    "",
    "Do this:",
    "0. worth: true or false. skip_reason: if worth is false, a short reason IN JAPANESE (under 20 characters); otherwise an empty string. If worth is false, leave every other field as an empty string or empty list.",
    ...SPOKEN,
    "3. point: 1-2 short sentences IN JAPANESE on the key to saying it this way (word choice, nuance or grammar), so it is easy to remember. If the conversation changes how it should be said, mention that briefly.",
    "4. phrase: one reusable expression from the model answer; phrase_ja: its meaning in Japanese.",
    "",
    "Reply with only JSON like:",
    '{"worth":true,"skip_reason":"","model":"...","alts":["..."],"point":"...","phrase":"...","phrase_ja":"..."}'
  ].join("\n");
}

export function buildGradePrompt(req: CoachRequest): string {
  const ja = clip(req.ja, 400), answer = clip(req.answer, 500), ref = clip(req.ref, 400);
  return [
    "You are an English coach for a Japanese adult. They practice SAYING their OWN real LINE messages (casual texts to a friend) out loud in natural spoken English.",
    "",
    NAMES_RULE + contextBlock(ja, req.context ?? null) + "Japanese message they actually sent:",
    "<<<" + ja + ">>>",
    "",
    ref ? "Model answer they were shown before (keep it as the model answer unless it is clearly wrong or unnatural; drop any text-only parts such as lol, haha or emoji, and spell out texting abbreviations such as tmrw):\n<<<" + ref + ">>>\n" : "",
    "Their English attempt (it may come from speech recognition, so ignore capitalization, punctuation and obvious mishearings):",
    "<<<" + (answer || "(no attempt: they gave up and want to see the answer)") + ">>>",
    "",
    "Do this:",
    ...SPOKEN,
    "3. verdict: judge ONLY whether the meaning gets across. \"correct\" if an English-speaking friend would understand what they meant at that point in the conversation, even if it is worded differently from the model, has grammar mistakes, or sounds unnatural. \"close\" if the main point comes through but an important part is missing or slightly off. \"wrong\" if the meaning does not come through, it is not English, or there is no attempt. " + PRONOUN_OK,
    "4. feedback: 1-2 short sentences IN JAPANESE about whether the meaning came through (and which part was missing or off, if any). Do not comment on grammar or naturalness here. If there is no attempt, explain the key point of the model answer.",
    "5. natural: if native speakers would more typically say what the learner said in a different way, write that version. Stay as close as possible to the learner's own wording and change only what natives would phrase differently. Natural means what natives actually prefer to say in casual texts, NOT grammatical correctness: do not change something only to fix grammar if natives commonly say it that way (dropped subjects, fragments and contractions are fine), and a grammatically perfect sentence can still be unnatural. Follow the speaking-only rule: never add lol, haha or emoji, and do not suggest a change only because the attempt left them out. Use an empty string if the attempt already sounds like what a native would say, if the verdict is wrong, or if there is no attempt.",
    "6. natural_why: if natural is not empty, 1 short sentence IN JAPANESE on why natives prefer it (for example, which word sounds stiff or textbook-like and what natives say instead). Otherwise an empty string.",
    "7. phrase: one reusable expression from the model answer; phrase_ja: its meaning in Japanese.",
    "",
    "Reply with only JSON like:",
    '{"model":"...","alts":["..."],"verdict":"correct","feedback":"...","natural":"...","natural_why":"...","phrase":"...","phrase_ja":"..."}'
  ].join("\n");
}

export function parseJson(text: string): Record<string, unknown> | null {
  const t = String(text || "").replace(/```(?:json)?/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}
