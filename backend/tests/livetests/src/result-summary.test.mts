import { describe, it, expect } from "vitest";
import { renderResultsMarkdown } from "./result-summary.mjs";
import type { PlannedScenario, TestResult } from "./livetest-types.mjs";

function planned(
  id: string,
  app: string,
  variant: string,
  options: { addons?: string[]; task?: string; skipExecution?: boolean } = {},
): PlannedScenario {
  return {
    vmId: 200,
    hostname: `${app}-${variant}`,
    stackName: variant,
    scenario: {
      id,
      application: app,
      description: `Test ${id}`,
      ...(options.addons ? { selectedAddons: options.addons } : {}),
      ...(options.task ? { task: options.task } : {}),
    },
    hasStacktype: false,
    isDependency: false,
    skipExecution: !!options.skipExecution,
  };
}

describe("renderResultsMarkdown", () => {
  it("renders a single passing scenario with check marks", () => {
    const r: TestResult = {
      name: "main",
      description: "main",
      passed: 1,
      failed: 0,
      steps: [
        {
          vmId: 200,
          hostname: "postgres-default",
          application: "postgres",
          scenarioId: "postgres/default",
          cliOutput: "ok\n",
        },
      ],
      errors: [],
    };
    const md = renderResultsMarkdown([r], [planned("postgres/default", "postgres", "default")]);
    expect(md).toContain("| postgres | default |");
    expect(md).toContain("✅ pass");
    expect(md).toContain("_(no stderr)_");
  });

  it("renders ssl/oidc badges and task", () => {
    const md = renderResultsMarkdown(
      [{ name: "n", description: "", passed: 1, failed: 0, steps: [], errors: [] }],
      [
        planned("zitadel/upgrade", "zitadel", "upgrade", {
          addons: ["addon-ssl"],
          task: "upgrade",
        }),
      ],
    );
    expect(md).toContain("| ✅ | ❌ | upgrade |");
  });

  it("marks failed scenario and includes tail", () => {
    const tail = Array.from({ length: 15 }, (_, i) => `line${i}`).join("\n");
    const r: TestResult = {
      name: "main",
      description: "",
      passed: 0,
      failed: 1,
      steps: [
        {
          vmId: 200,
          hostname: "x",
          application: "zitadel",
          scenarioId: "zitadel/default",
          cliOutput: tail,
        },
      ],
      errors: ["zitadel/default failed: something bad happened"],
    };
    const md = renderResultsMarkdown([r], [planned("zitadel/default", "zitadel", "default")]);
    expect(md).toContain("❌ fail");
    expect(md).toContain("<pre>");
    expect(md).toContain("line14");
    expect(md).not.toContain("line4"); // last 10: line5..line14
  });

  it("marks skipped scenarios from blocked-by-dependency errors", () => {
    const r: TestResult = {
      name: "main",
      description: "",
      passed: 0,
      failed: 0,
      steps: [],
      errors: ["Skipped: zitadel/upgrade (dependency zitadel/default blocked)"],
    };
    const md = renderResultsMarkdown(
      [r],
      [planned("zitadel/upgrade", "zitadel", "upgrade", { skipExecution: true })],
    );
    expect(md).toContain("⏭ skipped");
    expect(md).toContain("_(dependency failed)_");
  });

  it("escapes HTML in tail content", () => {
    const r: TestResult = {
      name: "main",
      description: "",
      passed: 0,
      failed: 1,
      steps: [
        {
          vmId: 200,
          hostname: "x",
          application: "app",
          scenarioId: "app/v",
          cliOutput: "<script>bad</script>\nrow & more",
        },
      ],
      errors: ["app/v failed"],
    };
    const md = renderResultsMarkdown([r], [planned("app/v", "app", "v")]);
    expect(md).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(md).toContain("row &amp; more");
  });
});
