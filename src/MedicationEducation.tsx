import type { GroundedResult, Medication } from "../shared/schema";
import "./MedicationEducation.css";

const topicDefinitions = [
  { id: "purpose", title: "主要用途", prompt: "這款藥用來做什麼？" },
  { id: "use", title: "一般使用方法", prompt: "仿單有哪些操作說明？" },
  {
    id: "precautions",
    title: "使用注意與禁忌",
    prompt: "使用前要留意哪些條件？",
  },
  {
    id: "effects",
    title: "副作用與過量處理",
    prompt: "仿單記載哪些反應與處理方式？",
  },
  { id: "storage", title: "保存方式", prompt: "這款藥應如何保存？" },
] as const;

type TopicId = (typeof topicDefinitions)[number]["id"];

function sectionTopic(section: string): TopicId | null {
  if (/副作用|不良反應|過量/u.test(section)) return "effects";
  if (/儲存|貯存|保存|安定性/u.test(section)) return "storage";
  if (/適應症|用途/u.test(section)) return "purpose";
  if (/使用方法|用法|用量|操作/u.test(section)) return "use";
  if (/警語|注意|禁忌|交互作用|特殊族群|病人使用須知/u.test(section))
    return "precautions";
  return null;
}

/** Navigate only existing claims. Never infer advice from the drug name/form. */
export function medicationEducationTopics(result: GroundedResult) {
  const indices = new Map<TopicId, Set<number>>(
    topicDefinitions.map((topic) => [topic.id, new Set<number>()]),
  );
  const sectionsByClaim = new Map<number, Set<string>>();
  const addSection = (index: number, section: string) => {
    if (!result.claims[index]) return;
    const sections = sectionsByClaim.get(index) || new Set<string>();
    sections.add(section);
    sectionsByClaim.set(index, sections);
  };
  for (const field of result.plainLanguageCoverage?.fields || [])
    for (const index of field.claimIndices)
      addSection(index, field.sourceSection);
  for (const section of result.safetyCoverage?.sections || [])
    for (const index of section.claimIndices || [section.claimIndex])
      addSection(index, section.sourceSection);
  result.claims.forEach((claim, index) => {
    if (!claim.citations.length) return;
    const mapped = [...(sectionsByClaim.get(index) || [])]
      .map(sectionTopic)
      .filter((topic): topic is TopicId => topic !== null);
    if (mapped.length) {
      for (const topic of mapped) indices.get(topic)!.add(index);
      return;
    }
    const fallback =
      claim.category === "purpose" ||
      claim.kind === "purpose" ||
      claim.kind === "source_exact_purpose"
        ? "purpose"
        : claim.category === "use"
          ? "use"
          : claim.category === "warning" ||
              claim.kind === "source_exact_safety" ||
              claim.profileRefs?.length ||
              claim.sourceMentions?.length
            ? "precautions"
            : null;
    if (fallback) indices.get(fallback)!.add(index);
  });
  return topicDefinitions.map((topic) => ({
    ...topic,
    claimIndices: [...indices.get(topic.id)!].sort((a, b) => a - b),
  }));
}

export function MedicationEducation({
  result,
  medications = [],
  onReadClaim,
}: {
  result: GroundedResult;
  medications?: Medication[];
  onReadClaim: (index: number) => void;
}) {
  const topics = medicationEducationTopics(result);
  const purposeIndex = topics.find((topic) => topic.id === "purpose")
    ?.claimIndices[0];
  const purpose =
    purposeIndex === undefined ? undefined : result.claims[purposeIndex];
  return (
    <section className="medication-education" aria-label="藥品衛教導覽">
      <h3>先認識這款藥，再看使用注意</h3>
      {medications.length > 0 && (
        <ul className="medication-education-products">
          {medications.map((medication) => (
            <li key={medication.id}>
              <strong>{medication.name}</strong>
              <span>
                {[medication.strength, medication.form]
                  .filter(Boolean)
                  .join(" · ") || "規格與劑型尚未填寫"}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="medication-education-summary">
        <h4>先看主要用途</h4>
        {purpose && purposeIndex !== undefined ? (
          <>
            <p>{purpose.text}</p>
            <button type="button" onClick={() => onReadClaim(purposeIndex)}>
              對照這段用途的依據
            </button>
            <p className="fine">
              這是仿單記載的用途，不代表你個人適合使用或醫師為你開藥的原因。
            </p>
          </>
        ) : (
          <p>
            目前沒有可核對的用途說明，可先閱讀下方已有來源的衛教，或開啟官方仿單原文。
          </p>
        )}
      </div>
      <p>選擇想了解的主題，前往已有仿單依據的說明。不需要先填每天使用次數。</p>
      <ul className="medication-education-topics">
        {topics.map((topic) => (
          <li key={topic.id}>
            <div>
              <strong>{topic.title}</strong>
              <p>{topic.prompt}</p>
            </div>
            {topic.claimIndices.length ? (
              <button
                type="button"
                aria-label={`閱讀${topic.title}：${topic.claimIndices.length} 則說明`}
                onClick={() => onReadClaim(topic.claimIndices[0])}
              >
                閱讀 {topic.claimIndices.length} 則說明
              </button>
            ) : (
              <span className="medication-education-missing">
                尚無可核對說明
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="fine">
        本頁呈現已整理的內容；沒有列出某主題，不代表沒有相關風險或限制。未整理的部分請對照完整仿單原文。
      </p>
    </section>
  );
}
