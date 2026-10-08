/* High-signal, change-only bypass checks. This is not a control/data-flow proof.
 * Domain triage, bootstrap wiring and role safety have separate runtime tests.
 */
const { readFileSync, existsSync } = require("node:fs");
const { resolve, basename } = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");

const boundaries = new Set([
  "backend/src/common/api-error.ts",
  "backend/src/common/global-http-exception.filter.ts",
  "backend/src/ops/ops-failure.ts",
  "frontend/src/components/states/ErrorState.tsx",
  "frontend/src/components/states/ErrorNotice.tsx",
]);
const productionFile = (path, scope) =>
  path.startsWith(`${scope}/src/`) &&
  /\.tsx?$/u.test(path) &&
  !/(?:\.spec|\.test)\.tsx?$|\/generated\//u.test(path);

function findings(ts, path, text, scope) {
  const tree = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const printer = ts.createPrinter({ removeComments: true });
  const result = [];
  const name = (node) =>
    node && (ts.isIdentifier(node) || ts.isStringLiteral(node))
      ? node.text
      : "";
  const walk = (node, visit) => {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  };
  const report = (node, rule) =>
    result.push({
      path,
      rule,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      key: `${rule}:${printer.printNode(ts.EmitHint.Unspecified, node, tree)}`,
    });
  // Local import spelling only, including aliases. No module resolution or graph.
  const imported = new Map();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name)
      imported.set(clause.name.text, {
        symbol: basename(module).replace(/\.tsx?$/u, ""),
        module,
      });
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements)
        imported.set(item.name.text, {
          symbol: name(item.propertyName ?? item.name),
          module,
        });
    if (bindings && ts.isNamespaceImport(bindings))
      imported.set(bindings.name.text, { symbol: "*", module });
  }
  const symbol = (node) => imported.get(name(node))?.symbol ?? name(node);
  const from = (node, file) =>
    imported
      .get(name(node))
      ?.module.replace(/\.tsx?$/u, "")
      .endsWith(`/${file}`);
  const isCall = (node, fn, file) =>
    ts.isCallExpression(node) &&
    symbol(node.expression) === fn &&
    from(node.expression, file);
  // A directly projected local is a common persistence idiom, not a helper chain.
  const projectedLocals = new Set();
  walk(tree, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isCall(node.initializer, "projectOpsFailure", "ops-failure")
    )
      projectedLocals.add(name(node.name));
  });
  const fields = (node) => new Set(node.properties.map((p) => name(p.name)));
  const preauth = path.startsWith("frontend/src/screens/auth/");
  const jsx = (node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isJsxExpression(parent)) return parent;
      if (ts.isFunctionLike(parent)) break;
    }
  };
  const rawName =
    /^(?:error|err|failure|exception|cause|payload|serverMessage)$/iu;
  const rawValue = (node) => {
    if (
      ts.isCallExpression(node) &&
      [
        ["safeAdminDiagnosticLog", "admin-diagnostics"],
        ["classifyFailureCause", "safe-failure-cause"],
        ["projectOpsFailure", "ops-failure"],
      ].some(([fn, file]) => isCall(node, fn, file))
    )
      return false;
    if (ts.isIdentifier(node) && rawName.test(node.text)) return true;
    if (
      ts.isPropertyAccessExpression(node) &&
      /^(?:message|stack|serverMessage|payload|rawPayload|response|body)$/u.test(
        node.name.text,
      )
    )
      return true;
    return ts.forEachChild(node, rawValue) === true;
  };
  walk(tree, (node) => {
    if (scope === "backend") {
      if (ts.isNewExpression(node)) {
        const expression = node.expression;
        const nest =
          imported.get(name(expression))?.module === "@nestjs/common" ||
          (ts.isPropertyAccessExpression(expression) &&
            imported.get(name(expression.expression))?.module ===
              "@nestjs/common");
        const constructor = ts.isPropertyAccessExpression(expression)
          ? name(expression.name)
          : symbol(expression);
        if (nest && /Exception$/u.test(constructor)) {
          report(
            node,
            "Use an approved HTTP factory; direct exceptions bypass public message policy.",
          );
        } else if (
          /(?:Error|Exception)$/u.test(constructor) &&
          !isCall(node.parent, "projectOpsFailure", "ops-failure") &&
          !/@diagnosticSurface internal: \S.+/u.test(
            tree.text.slice(node.parent.getFullStart(), node.getStart()),
          )
        ) {
          report(
            node,
            "Raw error emitter needs an HTTP/Ops boundary or a local @diagnosticSurface internal: reason.",
          );
        }
      }
      if (ts.isObjectLiteralExpression(node)) {
        const keys = fields(node);
        const partial = node.properties.some(
          (p) =>
            name(p.name) === "diagnostic" &&
            ts.isPropertyAssignment(p) &&
            isCall(
              p.initializer,
              "buildAdminPartialFailureDiagnostic",
              "admin-diagnostics",
            ),
        );
        if (
          keys.has("code") &&
          keys.has("message") &&
          !partial &&
          !isCall(node.parent, "projectOpsFailure", "ops-failure")
        )
          report(
            node,
            "Unassigned structured error: use an HTTP factory, partial diagnostic or projectOpsFailure.",
          );
        const projectedFields = ["errorCode", "errorMessage"].every((key) =>
          node.properties.some(
            (p) =>
              name(p.name) === key &&
              ts.isPropertyAssignment(p) &&
              ts.isPropertyAccessExpression(p.initializer) &&
              (projectedLocals.has(name(p.initializer.expression)) ||
                isCall(
                  p.initializer.expression,
                  "projectOpsFailure",
                  "ops-failure",
                )),
          ),
        );
        if (
          keys.has("errorCode") &&
          keys.has("errorMessage") &&
          !projectedFields &&
          !(
            ts.isCallExpression(node.parent) &&
            ts.isPropertyAccessExpression(node.parent.expression) &&
            node.parent.expression.name.text === "recordFailed"
          )
        )
          report(
            node,
            "Ops failure fields must pass through the Ops persistence boundary.",
          );
      }
      if (
        (ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) &&
          /^(?:code|errorCode)$/u.test(node.left.name.text)) ||
        (ts.isPropertyDeclaration(node) &&
          /^(?:code|errorCode)$/u.test(name(node.name)))
      )
        report(
          node,
          "New coded error requires an approved diagnostic surface.",
        );
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression.getText(tree);
        if (
          /^(?:error|warn|log|debug|verbose|fatal)$/u.test(method) &&
          /logger|^console$/iu.test(receiver) &&
          node.arguments.some(rawValue)
        )
          report(
            node,
            "Do not log raw exceptions/messages/payloads; use a safe projection.",
          );
        if (
          /^(?:json|send)$/u.test(method) &&
          /\b(?:res|response)\b/u.test(receiver) &&
          node.arguments.some(
            (arg) =>
              ts.isObjectLiteralExpression(arg) && fields(arg).has("error"),
          )
        )
          report(
            node,
            "Direct HTTP error response bypasses the global exception filter.",
          );
      }
    } else {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const component = symbol(node.tagName);
        if (from(node.tagName, component)) {
          if (preauth && component === "AdminDiagnosticPanel")
            report(
              node,
              "Pre-auth workflows must not expose an admin diagnostic panel.",
            );
          if (!preauth && /^(?:ErrorState|ErrorNotice)$/u.test(component)) {
            const error = node.attributes.properties.find(
              (p) => ts.isJsxAttribute(p) && name(p.name) === "error",
            );
            if (
              !error?.initializer ||
              (ts.isJsxExpression(error.initializer) &&
                (!error.initializer.expression ||
                  /^(?:undefined|null|false)$/u.test(
                    error.initializer.expression.getText(tree),
                  )))
            )
              report(node, `${component} must receive the original error.`);
          }
        }
      }
      if (
        !preauth &&
        ts.isCallExpression(node) &&
        /^set.*(?:Error|Failure|Message)$/u.test(name(node.expression)) &&
        node.arguments.some((arg) =>
          isCall(arg, "getApiErrorDisplayMessage", "errorMapper"),
        )
      )
        report(
          node,
          "Keep the original error; message-only state loses admin diagnostics.",
        );
      if (
        ts.isPropertyAccessExpression(node) &&
        (/^(?:serverMessage|clientMessage)$/u.test(node.name.text) ||
          (/^(?:message|code|status|stack|requestId|failureStage)$/u.test(
            node.name.text,
          ) &&
            /\b(?:error|failure|err|exception)\b/iu.test(
              node.expression.getText(tree),
            )))
      ) {
        if (
          jsx(node) ||
          (ts.isCallExpression(node.parent) &&
            /^set.*(?:Error|Failure)$/u.test(name(node.parent.expression)))
        )
          report(
            node,
            "Raw exception/server text or fields are not public JSX copy.",
          );
      }
      if (
        ts.isIdentifier(node) &&
        node.text === "serverMessage" &&
        ts.isJsxExpression(node.parent)
      )
        report(node, "Raw server message is not public JSX copy.");
      if (
        ts.isCallExpression(node) &&
        from(node.expression, "errorMapper") &&
        /^(?:getApiErrorServerMessage|getApiErrorCode|getApiErrorStatus|getApiErrorInfo)$/u.test(
          symbol(node.expression),
        ) &&
        ts.isJsxExpression(node.parent)
      )
        report(node, "Raw error mapper fields are not public JSX copy.");
    }
  });
  return result;
}

function auditSources(ts, base, current, scope) {
  const violations = [];
  for (const [path, source] of current) {
    if (
      !productionFile(path, scope) ||
      boundaries.has(path) ||
      source === base.get(path)
    )
      continue;
    const counts = new Map();
    for (const issue of findings(ts, path, base.get(path) ?? "", scope))
      counts.set(issue.key, (counts.get(issue.key) ?? 0) + 1);
    for (const { key, ...issue } of findings(ts, path, source, scope)) {
      const previous = counts.get(key) ?? 0;
      if (previous) counts.set(key, previous - 1);
      else violations.push(issue);
    }
  }
  return violations;
}

function runAudit(
  root,
  scope,
  baseRef = process.env.DIAGNOSTIC_AUDIT_BASE || "HEAD",
) {
  if (!["backend", "frontend"].includes(scope))
    throw new Error("Expected backend/frontend scope.");
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    !process.env.DIAGNOSTIC_AUDIT_BASE
  )
    throw new Error("CI diagnostic comparison base is required.");
  const git = (args, input) =>
    execFileSync("git", args, {
      cwd: root,
      input,
      maxBuffer: 64 * 1024 * 1024,
    });
  const commit = git([
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${baseRef}^{commit}`,
  ])
    .toString()
    .trim();
  const paths = [
    ...new Set([
      ...git([
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        commit,
        "--",
        `${scope}/src`,
      ])
        .toString()
        .split("\0"),
      ...git([
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        `${scope}/src`,
      ])
        .toString()
        .split("\0"),
    ]),
  ].filter(
    (path) =>
      productionFile(path, scope) &&
      !boundaries.has(path) &&
      existsSync(resolve(root, path)),
  );
  if (!paths.length) return [];
  if (paths.some((path) => /[\r\n]/u.test(path)))
    throw new Error("Unsupported newline in source path.");
  // One Git process for all needed base blobs, not one process per repository file.
  const blobs = git(
    ["cat-file", "--batch"],
    paths.map((path) => `${commit}:${path}\n`).join(""),
  );
  const base = new Map(),
    current = new Map();
  let offset = 0;
  for (const path of paths) {
    const end = blobs.indexOf(10, offset);
    if (end < 0) throw new Error("Incomplete git cat-file response.");
    const header = blobs.subarray(offset, end).toString();
    offset = end + 1;
    if (!header.endsWith(" missing")) {
      const match = /^\w+ blob (\d+)$/u.exec(header);
      if (!match) throw new Error("Unexpected git cat-file response.");
      const size = Number(match[1]);
      base.set(path, blobs.subarray(offset, offset + size).toString());
      offset += size + 1;
    }
    current.set(path, readFileSync(resolve(root, path), "utf8"));
  }
  const ts = createRequire(resolve(root, scope, "package.json"))("typescript");
  return auditSources(ts, base, current, scope);
}

module.exports = { auditSources, runAudit };
if (require.main === module) {
  const scope = process.argv[2];
  const violations = runAudit(resolve(__dirname, ".."), scope);
  for (const issue of violations)
    process.stderr.write(`${issue.path}:${issue.line}: ${issue.rule}\n`);
  process.stdout.write(
    `Diagnostic bypass gate (${scope}): ${violations.length ? "FAIL" : "PASS"}\n`,
  );
  process.exitCode = violations.length ? 1 : 0;
}
