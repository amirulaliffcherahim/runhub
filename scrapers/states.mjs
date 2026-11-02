/**
 * State canonicalisation + inference. Portals disagree ("Pulau Pinang" vs
 * "Penang", "KL"), and several give no state at all.
 */
const STATES = [
  ["Kuala Lumpur", /\b(kuala lumpur|klcc|bukit jalil|titiwangsa|bangsar|cheras|kepong|sri petaling|mont kiara|setiawangsa)\b/i],
  ["Selangor", /\b(selangor|shah alam|petaling jaya|subang|klang|cyberjaya|sepang|putra heights|bangi|kajang|rawang|ampang|gombak|sunway|puchong|seri kembangan|ban canal|kuala selangor|hulu langat|sabak bernam|banting)\b/i],
  ["Putrajaya", /\b(putrajaya|presint)\b/i],
  ["Penang", /\b(penang|pulau pinang|george ?town|butterworth|bayan lepas|seberang jaya|bukit mertajam)\b/i],
  ["Perak", /\b(perak|ipoh|taiping|kuala kangsar|teluk intan|lumut|sitiawan)\b/i],
  ["Kedah", /\b(kedah|alor setar|sungai petani|langkawi|kulim)\b/i],
  ["Perlis", /\b(perlis|kangar|wang kelian)\b/i],
  ["Kelantan", /\b(kelantan|kota bharu|kota bahru)\b/i],
  ["Terengganu", /\b(terengganu|kuala terengganu|kemaman|dungun)\b/i],
  ["Pahang", /\b(pahang|kuantan|cameron highlands|bentong|temerloh)\b/i],
  ["Johor", /\b(johor|johor bahru|iskandar|muar|batu pahat|kluang|medini|pasir gudang|desaru)\b/i],
  ["Melaka", /\b(melaka|malacca|ayer keroh|alor gajah)\b/i],
  ["Negeri Sembilan", /\b(negeri sembilan|seremban|port dickson)\b/i],
  ["Sabah", /\b(sabah|kota kinabalu|sandakan|tawau|kundasang)\b/i],
  ["Sarawak", /\b(sarawak|kuching|miri|sibu|bintulu|padungan)\b/i],
  ["Labuan", /\b(labuan)\b/i],
];

const ALIASES = { kl: "Kuala Lumpur", wpkl: "Kuala Lumpur", "wp kuala lumpur": "Kuala Lumpur" };

/** Map a portal-supplied state (or any place text) to a canonical name, or null. */
export function canonicalState(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (ALIASES[s.toLowerCase()]) return ALIASES[s.toLowerCase()];
  for (const [name, re] of STATES) if (re.test(s)) return name;
  return null; // "Anywhere", "Online", "Malaysia", unknown
}

/** Canonical `event.state`, inferred from venue then title when the portal gave none. */
export function resolveState(event) {
  return (
    canonicalState(event.state) ?? canonicalState(event.venue) ?? canonicalState(event.title)
  );
}

// A running aggregator should not list badminton cups or business seminars.
// Denylist, not allowlist: an allowlist silently dropped real races whose titles
// carry no keyword ("Selmar 2026", "Race Against Cancer", "RUNLIGA Team Race").
const RUNNING =
  /\b(run|runs|running|marathon|trail|ultra|walk|funwalk|jog|lari|larian|relay|triathlon|duathlon|aquathlon|race|\d+\s*k(m)?)\b/i;

const NOT_RUNNING =
  /\b(badminton|pickleball|tennis|golf|futsal|football|basketball|volleyball|zumba|yoga|pilates|aerobics|cycling|kayuhan|mtb|mountain ?bike|ride for|swim|swimming|seminar|workshop|webinar|conference|hiring|recruitment|business|masterclass|mastery|training session|conditioning|picnic|pool party|party|dinner|gala|concert|roadshow)\b/i;

/** Keep the event unless it clearly belongs to another sport or is not an event at all. */
export const isRunning = (event) => {
  const text = `${event.title ?? ""} ${(event.description ?? "").slice(0, 400)}`;
  if (RUNNING.test(text)) return true;
  return !NOT_RUNNING.test(text);
};
