import type {
  GroundedResult,
  LearningProgress,
  ProfileReference,
} from "./schema.js";

/** Only explicitly supplied profile facts may be used as personalization labels. */
export function profileFacts(profile: unknown): ProfileReference[] {
  if (!profile || typeof profile !== "object") return [];
  const p = profile as Record<string, unknown>;
  const facts: ProfileReference[] = [];
  if (
    typeof p.age === "number" &&
    Number.isInteger(p.age) &&
    p.age >= 0 &&
    p.age <= 120
  )
    facts.push({ field: "age", value: String(p.age) });
  if (p.sex === "female" || p.sex === "male")
    facts.push({ field: "sex", value: p.sex });
  if (Array.isArray(p.conditions))
    for (const value of p.conditions)
      if (typeof value === "string" && value.trim())
        facts.push({ field: "conditions", value });
  if (typeof p.allergies === "string" && p.allergies.trim())
    facts.push({ field: "allergies", value: p.allergies });
  if (
    p.pregnancy === "pregnant" ||
    p.pregnancy === "lactating" ||
    p.pregnancy === "no"
  )
    facts.push({ field: "pregnancy", value: p.pregnancy });
  return facts;
}

export function profileReferenceLabel(ref: ProfileReference): string {
  switch (ref.field) {
    case "age":
      return "年齡：" + ref.value + " 歲";
    case "sex":
      return "生理性別：" + (ref.value === "female" ? "女性" : "男性");
    case "conditions":
      return "健康狀況：" + ref.value;
    case "allergies":
      return "過敏史：" + ref.value;
    case "pregnancy":
      return (
        "懷孕／哺乳：" +
        ({ pregnant: "懷孕中", lactating: "哺乳中", no: "否" }[ref.value] ||
          ref.value)
      );
  }
}

/** Literal scope fragments for generation hints and the independent refusal gate. */
export function warningConditions(quotes: string[]): string[] {
  const normalize = (value: string) =>
    value.normalize("NFKC").replace(/\s/g, "");
  return [
    ...new Set(
      quotes.flatMap((quote) => {
        const source = normalize(quote);
        // Preserve causal scope and exceptions even if the generator omitted them
        // from its declared conditions. A condition in a profile is not its cause.
        const conditions =
          source.match(
            /所引起(?:之|的)?[^，,。；;！？!?]+|除非[^，,。；;！？!?]+|(?:若|一旦)[^，,。；;！？!?]+/gu,
          ) || [];
        return conditions
          .map(
            (condition) =>
              condition.split(/請勿|不得|不宜|不建議|應|須|請|不可|避免/)[0],
          )
          .filter(Boolean);
      }),
    ),
  ];
}

/** Literal conditions are an extra refusal gate, never a semantic approval. */
export function warningConditionsPreserved(
  text: string,
  quotes: string[],
): boolean {
  const target = text.normalize("NFKC").replace(/\s/g, "");
  return warningConditions(quotes).every((scope) => target.includes(scope));
}

export function validAnswers(
  quiz: GroundedResult["quiz"],
  answers: Record<string, number> = {},
): Record<string, number> {
  return Object.fromEntries(
    quiz.flatMap((q) => {
      const a = answers[q.id];
      return Number.isInteger(a) && a >= 0 && a < q.options.length
        ? [[q.id, a]]
        : [];
    }),
  );
}

export function learningProgress(
  quiz: GroundedResult["quiz"],
  answers: Record<string, number> = {},
): LearningProgress {
  const saved = validAnswers(quiz, answers);
  const results = quiz.map((q) => {
    const answered = Object.hasOwn(saved, q.id);
    const correct = answered && saved[q.id] === q.answer;
    return {
      id: q.id,
      state: !answered
        ? ("unanswered" as const)
        : correct
          ? ("correct" as const)
          : ("incorrect" as const),
      correct,
      answer: q.answer,
      explain: q.explain,
    };
  });
  const total = quiz.length;
  const answered = results.filter((r) => r.state !== "unanswered").length;
  const correct = results.filter((r) => r.correct).length;
  const passed = total > 0 && correct === total;
  return {
    total,
    answered,
    correct,
    passed,
    status: !total
      ? "unavailable"
      : passed
        ? "completed"
        : answered
          ? "in_progress"
          : "not_started",
    results,
  };
}
