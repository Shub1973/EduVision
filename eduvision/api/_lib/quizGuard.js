// Quiz guard: drops a quiz whose WRONG options use another faith's festival
// as a throwaway distractor (for example "Eid / Christmas" in a dhak quiz).
// Added 1 Nov 2026: the prompt forbids this, but Haiku 5.5 still did it now and
// then in Bengali, Hindi and English.
//
// Rule: find the faiths of any festival named in the question, the correct
// option, the concept or the display name (the "reference"). If a wrong option
// names a festival of a faith that is not in the reference, the quiz is dropped.
// With no festival in the reference, any festival in a wrong option drops it.
// A dropped quiz becomes null, which the app already shows as "no quiz".
// Festivals of the SAME faith as the reference are allowed (for example
// Durga Puja vs Kali Puja in a Hindu festival quiz).

// Latin names are matched as whole words (so "Holi" does not match "holiday");
// Bengali and Hindi names are matched as text. Generic words such as পূজা/पूजा
// and words that are also ordinary nouns (দোল = swing, as in দোলক, pendulum)
// are deliberately left out.
const FESTIVALS = {
  islam: [
    "eid", "eid al-fitr", "eid ul-fitr", "eid al-adha", "eid ul-adha", "bakrid", "bakri eid", "muharram", "ramadan", "ramzan",
    "ईद", "बकरीद", "मुहर्रम", "रमज़ान", "रमजान",
    "ঈদ", "মহরম", "রমজান", "রমযান",
  ],
  christianity: [
    "christmas", "easter", "good friday",
    "क्रिसमस", "बड़ा दिन", "ईस्टर", "गुड फ्राइडे",
    "বড়দিন", "ক্রিসমাস", "ইস্টার", "গুড ফ্রাইডে",
  ],
  hinduism: [
    "durga puja", "diwali", "deepavali", "holi", "navratri", "dussehra", "dasara", "kali puja", "saraswati puja", "janmashtami", "ganesh chaturthi", "chhath",
    "दुर्गा पूजा", "दिवाली", "दीपावली", "होली", "नवरात्रि", "नवरात्र", "दशहरा", "जन्माष्टमी", "गणेश चतुर्थी", "छठ",
    "দুর্গাপূজা", "দুর্গা পূজা", "দুর্গাপুজো", "দুর্গা পুজো", "দীপাবলি", "দিওয়ালি", "হোলি", "কালীপূজা", "কালী পূজা", "সরস্বতী পূজা", "জন্মাষ্টমী",
  ],
  sikhism: ["gurpurab", "guru nanak jayanti", "गुरुपर्व", "गुरु नानक जयंती", "গুরু নানক জয়ন্তী"],
  buddhism: ["buddha purnima", "बुद्ध पूर्णिमा", "বুদ্ধ পূর্ণিমা"],
  jainism: ["mahavir jayanti", "महावीर जयंती", "মহাবীর জয়ন্তী"],
};

function isLatin(term) { return /^[\x00-\x7F]+$/.test(term); }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Text and terms are NFC-normalised so ড়/ড় and ड़/ड़ (precomposed vs nukta) match.
const MATCHERS = Object.entries(FESTIVALS).flatMap(([faith, terms]) =>
  terms.map((t) => t.normalize("NFC").toLowerCase()).map((term) => ({
    faith,
    term,
    re: isLatin(term) ? new RegExp(`\\b${escapeRe(term)}\\b`, "i") : null,
  }))
);

function faithsIn(text) {
  const found = new Set();
  if (!text) return found;
  const s = String(text).normalize("NFC");
  const lower = s.toLowerCase();
  for (const m of MATCHERS) {
    if (m.re ? m.re.test(s) : lower.includes(m.term)) found.add(m.faith);
  }
  return found;
}

// Returns { drop: boolean, reason: string|null }.
function checkQuizFaith(parsed) {
  const q = parsed && parsed.quiz_question;
  if (!q || !Array.isArray(q.options) || typeof q.answer_index !== "number") {
    return { drop: false, reason: null };
  }
  const correct = q.options[q.answer_index];
  const reference = new Set([
    ...faithsIn(q.question), ...faithsIn(correct),
    ...faithsIn(parsed.concept ? String(parsed.concept).replace(/_/g, " ") : ""),
    ...faithsIn(parsed.display_name),
  ]);
  for (let i = 0; i < q.options.length; i++) {
    if (i === q.answer_index) continue;
    for (const faith of faithsIn(q.options[i])) {
      if (!reference.has(faith)) {
        return { drop: true, reason: `wrong option "${q.options[i]}" names a ${faith} festival` };
      }
    }
  }
  return { drop: false, reason: null };
}

module.exports = { checkQuizFaith, faithsIn };
