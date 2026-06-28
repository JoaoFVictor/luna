import ts from "typescript";

export function lifecycleStepMapViolations(
  relativePath: string,
  content: string
): string[] {
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const violations: string[] = [];

  function lineOf(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      .line + 1;
  }

  function functionName(node: ts.Node): string | undefined {
    let current: ts.Node | undefined = node;
    while (current !== undefined) {
      if (
        (ts.isFunctionDeclaration(current) ||
          ts.isFunctionExpression(current) ||
          ts.isArrowFunction(current) ||
          ts.isMethodDeclaration(current)) &&
        "name" in current &&
        current.name !== undefined &&
        ts.isIdentifier(current.name)
      ) {
        return current.name.text;
      }

      current = current.parent;
    }

    return undefined;
  }

  function isLifecycleFunction(node: ts.Node): boolean {
    const name = functionName(node);
    return (
      name !== undefined &&
      /lifecycle|Decision|cleanupMayRemoveWorktree|finalizeWriteSuccessWorkspace|finalizeSuccessWorkspace/i.test(
        name
      )
    );
  }

  function stringLiteralText(node: ts.Node | undefined): string | undefined {
    return node !== undefined && ts.isStringLiteralLike(node)
      ? node.text
      : undefined;
  }

  function isStepMapExpression(expression: ts.Expression): boolean {
    return [
      "steps",
      "state.steps",
      "scheduleState.steps",
      "scheduleResult.steps"
    ].includes(expression.getText(sourceFile));
  }

  function isLifecycleStepId(value: string): boolean {
    return [
      "acceptance",
      "acceptance_decision",
      "commit",
      "push",
      "change_request",
      "validation",
      "implementation",
      "implementation_validation",
      "diff",
      "collect_worktree_diff"
    ].includes(value);
  }

  function isRawOutputExpression(expression: ts.Expression): boolean {
    return ["output", "result.output", "result[\"output\"]"].includes(
      expression.getText(sourceFile)
    );
  }

  function isRawOutputKey(value: string): boolean {
    return ["final_validation", "validation", "status", "decision"].includes(value);
  }

  function containsStepMapExpression(node: ts.Node): boolean {
    let found = false;
    const scan = (current: ts.Node): void => {
      if (found) {
        return;
      }

      if (
        ts.isPropertyAccessExpression(current) &&
        current.name.text === "steps" &&
        ["state", "scheduleState", "scheduleResult"].includes(
          current.expression.getText(sourceFile)
        )
      ) {
        found = true;
        return;
      }

      if (
        ts.isElementAccessExpression(current) &&
        stringLiteralText(current.argumentExpression) === "steps" &&
        ["state", "scheduleState", "scheduleResult"].includes(
          current.expression.getText(sourceFile)
        )
      ) {
        found = true;
        return;
      }

      if (ts.isIdentifier(current) && current.text === "steps") {
        found = true;
        return;
      }

      ts.forEachChild(current, scan);
    };

    scan(node);
    return found;
  }

  function visit(node: ts.Node): void {
    if (relativePath === "src/capabilities/repository-change/lifecycle.ts") {
      if (
        ts.isPropertyAccessExpression(node) &&
        node.expression.getText(sourceFile) === "result" &&
        node.name.text === "output"
      ) {
        violations.push(
          `${relativePath}:${lineOf(node)} reads raw lifecycle output`
        );
      }

      if (
        ts.isElementAccessExpression(node) &&
        node.expression.getText(sourceFile) === "result" &&
        stringLiteralText(node.argumentExpression) === "output"
      ) {
        violations.push(
          `${relativePath}:${lineOf(node)} reads raw lifecycle output`
        );
      }
    }

    if (relativePath === "src/core/workflow/runner.ts") {
      if (
        ts.isFunctionDeclaration(node) &&
        ["nodeLifecycleOutcome", "workflowNodeStepResultFrom"].includes(
          node.name?.text ?? ""
        )
      ) {
        violations.push(
          `${relativePath}:${lineOf(node)} contains runner lifecycle output inference`
        );
      }

      if (
        ts.isPropertyAccessExpression(node) &&
        isRawOutputExpression(node.expression) &&
        isRawOutputKey(node.name.text)
      ) {
        violations.push(
          `${relativePath}:${lineOf(node)} reads raw node output for lifecycle`
        );
      }

      if (
        ts.isElementAccessExpression(node) &&
        isRawOutputExpression(node.expression) &&
        isRawOutputKey(stringLiteralText(node.argumentExpression) ?? "")
      ) {
        violations.push(
          `${relativePath}:${lineOf(node)} reads raw node output for lifecycle`
        );
      }
    }

    if (
      [
        "src/capabilities/repository-change/lifecycle.ts",
        "src/capabilities/repository-change/workspace-lifecycle.ts",
        "src/core/workflow/runner.ts"
      ].includes(relativePath)
    ) {
      if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        isLifecycleFunction(node) &&
        containsStepMapExpression(node)
      ) {
        violations.push(
          `${relativePath}:${lineOf(node)} reads step output maps inside lifecycle logic`
        );
      }

      if (
        ts.isPropertyAccessExpression(node) &&
        isLifecycleStepId(node.name.text) &&
        isStepMapExpression(node.expression)
      ) {
        violations.push(
          `${relativePath}:${lineOf(node)} indexes lifecycle step output maps`
        );
      }

      if (
        ts.isPropertyAccessExpression(node) &&
        node.expression.getText(sourceFile) === "scheduleResult" &&
        node.name.text === "steps" &&
        isLifecycleFunction(node)
      ) {
        violations.push(
          `${relativePath}:${lineOf(node)} reads scheduler step output maps`
        );
      }

      if (
        ts.isElementAccessExpression(node) &&
        isStepMapExpression(node.expression) &&
        isLifecycleStepId(stringLiteralText(node.argumentExpression) ?? "")
      ) {
        violations.push(
          `${relativePath}:${lineOf(node)} indexes lifecycle step output maps`
        );
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "implementationLifecycleEvidenceFromSteps"
    ) {
      violations.push(
        `${relativePath}:${lineOf(node)} calls implementationLifecycleEvidenceFromSteps`
      );
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      [
        "workspaceLifecycleDecision",
        "cleanupMayRemoveWorktree",
        "finalizeWriteSuccessWorkspace"
      ].includes(node.expression.text) &&
      node.arguments.some((argument) => containsStepMapExpression(argument))
    ) {
      violations.push(
        `${relativePath}:${lineOf(node)} passes step output maps into lifecycle`
      );
    }

    if (
      ts.isIdentifier(node) &&
      [
        "WorkflowNodeStepResult",
        "WorkflowNodeRunResult",
        "workflowNodeRunResult",
        "implementation_lifecycle"
      ].includes(node.text)
    ) {
      violations.push(
        `${relativePath}:${lineOf(node)} contains agent/loop lifecycle metadata`
      );
    }

    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      [
        "WorkflowNodeStepResult",
        "WorkflowNodeRunResult",
        "workflowNodeRunResult",
        "implementation_lifecycle"
      ].includes(node.text)
    ) {
      violations.push(
        `${relativePath}:${lineOf(node)} contains agent/loop lifecycle metadata`
      );
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}
