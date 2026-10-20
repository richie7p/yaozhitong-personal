import type { Locator } from "@playwright/test";

/** A completed review reopens at question one, even if another question was just corrected. */
export async function nextReviewedQuestion(quiz: Locator, currentIndex: number) {
  const review = quiz.getByRole("button", { name: "重新複習", exact: true });
  const reopened = await review.count() > 0;
  if (reopened) await review.click();
  for (let step = 0; step < (reopened ? currentIndex + 1 : 1); step++)
    await quiz.getByRole("button", { name: "下一題", exact: true }).click();
}
