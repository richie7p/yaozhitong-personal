export function FlowSteps({
  steps,
  current,
}: {
  steps: string[];
  current: number;
}) {
  return (
    <ol className="flow-steps" aria-label="操作步驟">
      {steps.map((step, index) => (
        <li
          className={`flow-step${index === current ? " is-current" : ""}${index < current ? " is-past" : ""}`}
          aria-current={index === current ? "step" : undefined}
          key={step}
        >
          <span className="flow-step-number" aria-hidden="true">
            {index + 1}
          </span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}
