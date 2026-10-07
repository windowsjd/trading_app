/* Change-aware AST gate. Existing P1 debt is the comparison base, not exemptions.
 * Boundary contracts and runtime triage tests run separately on every build.
 */
const { readFileSync, readdirSync, existsSync } = require("node:fs");
const { resolve, posix } = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");

function auditSources(ts, base, current, scope, requireBoundaries = false) {
  const printer = ts.createPrinter({ removeComments: true });
  const parse = (path, text) =>
    ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  const trees = new Map(
    [...current].map(([path, text]) => [path, parse(path, text)]),
  );
  const baseTrees = new Map(
    [...base].map(([path, text]) => [path, parse(path, text)]),
  );
  const name = (node) =>
    node && (ts.isIdentifier(node) || ts.isStringLiteral(node))
      ? node.text
      : "";
  const walk = (node, visit) => {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  };
  const owner = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (
        ts.isFunctionDeclaration(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isClassDeclaration(p)
      )
        return name(p.name);
    }
    return "<module>";
  };
  const fingerprint = (node, tree) => {
    // Moving an existing getter into visible JSX creates a new delivery path,
    // even when the getter's spelling has not changed.
    let presentation = "";
    if (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isJsxExpression(parent)) {
          presentation = `jsx:${ts.isJsxAttribute(parent.parent) ? name(parent.parent.name) : "children"}`;
          break;
        }
        if (ts.isFunctionLike(parent)) break;
      }
    }
    return `${owner(node)}:${presentation}:${node.kind}:${printer.printNode(ts.EmitHint.Unspecified, node, tree)}`;
  };
  const properties = (node) =>
    new Map(node.properties.map((p) => [name(p.name), p]));
  const imports = (tree) => {
    const result = new Map();
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements) {
          result.set(binding.name.text, {
            symbol: name(binding.propertyName ?? binding.name),
            module: statement.moduleSpecifier.text,
          });
        }
      if (statement.importClause?.name)
        result.set(statement.importClause.name.text, {
          symbol: "default",
          module: statement.moduleSpecifier.text,
        });
    }
    return result;
  };
  const resolveImport = (path, imported, sourceTrees) => {
    if (!imported.module.startsWith("."))
      return `${imported.module}:${imported.symbol}`;
    const stem = posix.normalize(
      posix.join(posix.dirname(path), imported.module),
    );
    const target = [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`].find(
      (p) => sourceTrees.has(p),
    );
    return `${target ?? stem}:${imported.symbol}`;
  };
  const callee = (path, tree, expression, sourceTrees) => {
    if (ts.isIdentifier(expression)) {
      const imported = imports(tree).get(expression.text);
      return imported
        ? resolveImport(path, imported, sourceTrees)
        : `${path}:${expression.text}`;
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      return `${path}:${expression.name.text}`;
    }
    return "";
  };
  // Discover existing domain factories from their terminal Nest envelope, rather
  // than maintaining an error-code/file exemption registry. New factories must
  // delegate to createApiError/projectOpsFailure.
  const statusName = (path, tree, expression, sourceTrees) => {
    if (!expression) return "";
    if (
      ts.isAsExpression(expression) ||
      ts.isParenthesizedExpression(expression)
    )
      return statusName(path, tree, expression.expression, sourceTrees);
    if (
      ts.isPropertyAccessExpression(expression) &&
      callee(path, tree, expression.expression, sourceTrees) ===
        "@nestjs/common:HttpStatus"
    )
      return `HttpStatus.${expression.name.text}`;
    return expression.getText(tree);
  };
  const factories = new Map([
    [
      "backend/src/common/api-error.ts:createApiError",
      { code: 0, status: 2, message: 1, safe: true },
    ],
    [
      "backend/src/ops/ops-failure.ts:projectOpsFailure",
      { code: 1, ops: true },
    ],
    [
      "backend/src/common/admin-diagnostics.ts:buildAdminPartialFailureDiagnostic",
      { code: 1, status: -1, partial: true, safe: true },
    ],
  ]);
  for (const [path, tree] of baseTrees)
    walk(tree, (node) => {
      if (
        !(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) ||
        !node.body
      )
        return;
      const params = node.parameters.map((p) => name(p.name));
      const code = params.findIndex((p) => /^(?:code|errorCode)$/u.test(p));
      if (code < 0 || !params.includes("message")) return;
      let terminal = false,
        defaultStatus = "",
        opsMapped = false;
      walk(node.body, (child) => {
        if (
          ts.isNewExpression(child) &&
          callee(path, tree, child.expression, baseTrees) ===
            "@nestjs/common:HttpException"
        ) {
          terminal = true;
          defaultStatus = statusName(
            path,
            tree,
            child.arguments?.[1],
            baseTrees,
          );
          walk(child.arguments?.[0] ?? child, (part) => {
            if (
              (ts.isPropertyAssignment(part) ||
                ts.isShorthandPropertyAssignment(part)) &&
              name(part.name) === "resultPayloadJson"
            )
              opsMapped = true;
          });
        }
      });
      const status = params.indexOf("status");
      if (status >= 0 && node.parameters[status].initializer)
        defaultStatus = statusName(
          path,
          tree,
          node.parameters[status].initializer,
          baseTrees,
        );
      if (terminal)
        factories.set(`${path}:${name(node.name)}`, {
          code,
          status,
          message: params.indexOf("message"),
          defaultStatus,
          opsMapped,
        });
    });
  // A migrated factory remains approved in subsequent PRs, when its original
  // Nest constructor has been replaced by a safe common-factory delegation.
  let discovered = true;
  while (discovered) {
    discovered = false;
    for (const [path, tree] of trees)
      walk(tree, (node) => {
        if (
          !(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) ||
          !node.body
        )
          return;
        const key = `${path}:${name(node.name)}`;
        if (factories.has(key)) return;
        const params = node.parameters.map((p) => name(p.name));
        const code = params.indexOf("code"),
          message = params.indexOf("message");
        if (code < 0 || message < 0) return;
        let delegate;
        walk(node.body, (child) => {
          if (ts.isCallExpression(child)) {
            const target = factories.get(
              callee(path, tree, child.expression, trees),
            );
            if (
              target &&
              !target.ops &&
              name(child.arguments[target.code]) === "code" &&
              name(child.arguments[target.message]) === "message"
            )
              delegate = target;
          }
        });
        if (delegate) {
          const status = params.indexOf("status");
          const defaultStatus =
            status >= 0
              ? statusName(
                  path,
                  tree,
                  node.parameters[status].initializer,
                  trees,
                )
              : delegate.defaultStatus;
          factories.set(key, {
            code,
            message,
            status,
            defaultStatus,
            safe: delegate.safe,
            opsMapped: delegate.opsMapped,
          });
          discovered = true;
        }
      });
  }
  const reviewedMessages = new Set();
  const messagePolicy = trees.get(
    "backend/src/common/safe-diagnostic-message.ts",
  );
  if (messagePolicy)
    walk(messagePolicy, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        name(node.name) === "SAFE_MESSAGES" &&
        node.initializer &&
        ts.isNewExpression(node.initializer)
      ) {
        const entries = node.initializer.arguments?.[0];
        if (entries && ts.isArrayLiteralExpression(entries))
          for (const item of entries.elements) {
            if (ts.isStringLiteral(item)) reviewedMessages.add(item.text);
          }
      }
    });
  const contracts = new Set(),
    routes = new Set(),
    opsContracts = new Set(),
    preauthContracts = new Set(),
    preauthSubjects = new Set();
  for (const [path, tree] of trees)
    if (path.endsWith(".spec.ts"))
      walk(tree, (node) => {
        if (
          ts.isCallExpression(node) &&
          callee(path, tree, node.expression, trees) ===
            "backend/scripts/lib/diagnostic-quality.ts:assertDiagnosticTriage" &&
          ts.isStringLiteral(node.arguments[1] ?? {}) &&
          ts.isStringLiteral(node.arguments[2] ?? {})
        ) {
          contracts.add(`${node.arguments[2].text}:${node.arguments[1].text}`);
        }
        if (
          ts.isCallExpression(node) &&
          callee(path, tree, node.expression, trees) ===
            "backend/scripts/lib/diagnostic-quality.ts:assertDiagnosticBaseline" &&
          ts.isStringLiteral(node.arguments[1] ?? {})
        ) {
          routes.add(node.arguments[1].text);
        }
        if (
          ts.isCallExpression(node) &&
          callee(path, tree, node.expression, trees) ===
            "backend/scripts/lib/diagnostic-quality.ts:assertPreAuthFailure" &&
          ts.isStringLiteral(node.arguments[1] ?? {})
        ) {
          preauthContracts.add(node.arguments[1].text);
        }
        if (
          ts.isCallExpression(node) &&
          callee(path, tree, node.expression, trees) ===
            "backend/scripts/lib/diagnostic-quality.ts:assertOpsFailure" &&
          ts.isStringLiteral(node.arguments[1] ?? {}) &&
          ts.isStringLiteral(node.arguments[2] ?? {})
        )
          opsContracts.add(
            `${node.arguments[2].text}:${node.arguments[1].text}`,
          );
      });
  // Resolve actual Public() entry points and their injected service methods.
  // An arbitrary comment cannot exempt an authenticated handler.
  for (const [path, tree] of trees)
    walk(tree, (node) => {
      if (!ts.isMethodDeclaration(node) || !ts.isClassDeclaration(node.parent))
        return;
      const isPublic = ts
        .getDecorators(node)
        ?.some(
          (d) =>
            ts.isCallExpression(d.expression) &&
            callee(path, tree, d.expression.expression, trees) ===
              "backend/src/auth/auth.decorators.ts:Public",
        );
      if (!isPublic) return;
      preauthSubjects.add(`${path}#${name(node.name)}`);
      const injections = new Map();
      for (const member of node.parent.members)
        if (ts.isConstructorDeclaration(member))
          for (const parameter of member.parameters) {
            if (parameter.type && ts.isTypeReferenceNode(parameter.type))
              injections.set(
                name(parameter.name),
                callee(path, tree, parameter.type.typeName, trees).split(
                  ":",
                )[0],
              );
          }
      if (node.body)
        walk(node.body, (child) => {
          if (
            !ts.isCallExpression(child) ||
            !ts.isPropertyAccessExpression(child.expression)
          )
            return;
          const receiver = child.expression.expression;
          if (
            ts.isPropertyAccessExpression(receiver) &&
            receiver.expression.kind === ts.SyntaxKind.ThisKeyword
          ) {
            const service = injections.get(receiver.name.text);
            if (service)
              preauthSubjects.add(`${service}#${child.expression.name.text}`);
          }
        });
    });
  const violations = [];
  if (requireBoundaries && scope === "backend") {
    const main = trees.get("backend/src/main.ts");
    let middleware = false,
      logger = false,
      filter = false;
    if (main)
      walk(main, (node) => {
        if (
          !ts.isCallExpression(node) ||
          !ts.isPropertyAccessExpression(node.expression)
        )
          return;
        if (
          node.expression.name.text === "use" &&
          node.arguments.some(
            (arg) =>
              callee("backend/src/main.ts", main, arg, trees) ===
              "backend/src/common/admin-diagnostics.ts:adminDiagnosticRequestMiddleware",
          )
        )
          middleware = true;
        if (
          node.expression.name.text === "useLogger" &&
          node.arguments.some(
            (arg) =>
              ts.isNewExpression(arg) &&
              callee("backend/src/main.ts", main, arg.expression, trees) ===
                "backend/src/common/admin-diagnostic.logger.ts:AdminDiagnosticLogger",
          )
        )
          logger = true;
      });
    const module = trees.get("backend/src/app.module.ts");
    if (module)
      walk(module, (node) => {
        if (!ts.isObjectLiteralExpression(node)) return;
        const fields = properties(node);
        const provided = fields.get("provide"),
          handler = fields.get("useClass");
        if (
          provided &&
          handler &&
          ts.isPropertyAssignment(provided) &&
          ts.isPropertyAssignment(handler) &&
          callee(
            "backend/src/app.module.ts",
            module,
            provided.initializer,
            trees,
          ) === "@nestjs/core:APP_FILTER" &&
          callee(
            "backend/src/app.module.ts",
            module,
            handler.initializer,
            trees,
          ) ===
            "backend/src/common/global-http-exception.filter.ts:GlobalHttpExceptionFilter"
        )
          filter = true;
      });
    for (const [bound, present] of [
      ["request middleware", middleware],
      ["safe logger", logger],
      ["global filter", filter],
    ]) {
      if (!present)
        violations.push({
          path: "backend/src/main.ts",
          line: 1,
          rule: `Missing common diagnostic ${bound} registration.`,
        });
    }
  }
  const boundaryFiles = new Set(
    scope === "backend"
      ? [
          "backend/src/common/api-error.ts",
          "backend/src/common/global-http-exception.filter.ts",
          "backend/src/ops/ops-failure.ts",
        ]
      : [
          "frontend/src/components/states/ErrorNotice.tsx",
          "frontend/src/components/states/ErrorState.tsx",
        ],
  );
  for (const [path, tree] of trees) {
    if (
      !path.startsWith(`${scope}/src/`) ||
      /(?:\.spec|\.test)\.ts$|\/generated\//u.test(path) ||
      boundaryFiles.has(path)
    )
      continue;
    const previous = baseTrees.get(path);
    const unchanged = new Map();
    if (previous)
      walk(previous, (node) => {
        const key = fingerprint(node, previous);
        unchanged.set(key, (unchanged.get(key) ?? 0) + 1);
      });
    const preauth = [
      "frontend/src/screens/auth/LoginScreen.tsx",
      "frontend/src/screens/auth/SignupScreen.tsx",
    ].includes(path);
    const projectedOpsField = (property) => {
      if (
        !ts.isPropertyAssignment(property) ||
        !ts.isPropertyAccessExpression(property.initializer)
      )
        return false;
      const identifier = property.initializer.expression;
      if (!ts.isIdentifier(identifier)) return false;
      let found = false;
      walk(tree, (candidate) => {
        if (
          ts.isVariableDeclaration(candidate) &&
          name(candidate.name) === identifier.text &&
          candidate.initializer &&
          ts.isCallExpression(candidate.initializer) &&
          callee(path, tree, candidate.initializer.expression, trees) ===
            "backend/src/ops/ops-failure.ts:projectOpsFailure"
        )
          found = true;
      });
      return found;
    };
    const meaningfulStage = (call) => {
      const target = callee(path, tree, call.expression, trees);
      if (
        target ===
        "backend/src/common/admin-diagnostics.ts:setAdminDiagnosticContext"
      ) {
        const update = call.arguments[0];
        const field =
          update &&
          ts.isObjectLiteralExpression(update) &&
          properties(update).get("failureStage");
        return (
          field &&
          ts.isPropertyAssignment(field) &&
          ts.isStringLiteral(field.initializer) &&
          ![
            "request_boundary",
            "request_processing",
            "backend_execution",
            "request_validation",
          ].includes(field.initializer.text)
        );
      }
      // Resolve an existing stage helper to its actual setter/parameter.
      const helperName = target.startsWith(`${path}:`)
        ? target.slice(path.length + 1)
        : "";
      let valid = false;
      for (const candidate of tree.statements)
        if (
          ts.isFunctionDeclaration(candidate) &&
          name(candidate.name) === helperName &&
          candidate.body
        ) {
          const index = candidate.parameters.findIndex(
            (p) => name(p.name) === "failureStage",
          );
          if (index < 0 || !ts.isStringLiteral(call.arguments[index] ?? {}))
            continue;
          walk(candidate.body, (child) => {
            if (
              ts.isCallExpression(child) &&
              callee(path, tree, child.expression, trees) ===
                "backend/src/common/admin-diagnostics.ts:setAdminDiagnosticContext"
            )
              valid = true;
          });
        }
      return valid;
    };
    const hasObservedStage = (emitter) => {
      for (
        let child = emitter, parent = emitter.parent;
        parent;
        child = parent, parent = parent.parent
      ) {
        if (!ts.isBlock(parent)) continue;
        for (const statement of parent.statements) {
          if (statement.getStart(tree) >= child.getStart(tree)) break;
          if (
            !ts.isExpressionStatement(statement) ||
            !ts.isCallExpression(statement.expression)
          )
            continue;
          if (meaningfulStage(statement.expression)) return true;
        }
      }
      return false;
    };
    const report = (node, rule) =>
      violations.push({
        path,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        rule,
      });
    const isNew = (node) => {
      const key = fingerprint(node, tree),
        count = unchanged.get(key) ?? 0;
      if (count) {
        unchanged.set(key, count - 1);
        return false;
      }
      return true;
    };
    walk(tree, (node) => {
      if (!isNew(node)) return;
      if (scope === "backend") {
        if (ts.isMethodDeclaration(node)) {
          const http = ts
            .getDecorators(node)
            ?.some(
              (decorator) =>
                ts.isCallExpression(decorator.expression) &&
                /^@nestjs\/common:(?:Get|Post|Put|Patch|Delete)$/u.test(
                  callee(path, tree, decorator.expression.expression, trees),
                ),
            );
          const subject = `${path}#${name(node.name)}`;
          if (
            http &&
            !(preauthSubjects.has(subject)
              ? preauthContracts.has(subject)
              : routes.has(subject))
          )
            report(
              node,
              "New/changed HTTP handler needs a scoped baseline (or Public pre-auth) contract; generic routes must declare observed workflow context.",
            );
        }
        if (ts.isNewExpression(node)) {
          const target = callee(path, tree, node.expression, trees);
          if (
            target.startsWith("@nestjs/common:") &&
            target.endsWith("Exception")
          )
            report(
              node,
              "Use an approved HTTP error factory; direct exceptions bypass reviewed message policy.",
            );
          if (
            !target.startsWith("@nestjs/common:") &&
            /(?:Error|Exception)$/u.test(
              target.split(":").at(-1) || name(node.expression),
            )
          ) {
            // Internal programming invariants need a local reason, not a file exemption.
            const statement = node.parent;
            if (
              !/@diagnosticSurface internal: .+/u.test(
                tree.text.slice(statement.getFullStart(), node.getStart()),
              )
            ) {
              report(
                node,
                "New Error emitter needs an approved HTTP/Ops path or a local @diagnosticSurface internal: reason.",
              );
            }
          }
        }
        if (ts.isObjectLiteralExpression(node)) {
          const fields = properties(node);
          const call = node.parent;
          const projectedInput =
            ts.isCallExpression(call) &&
            factories.get(callee(path, tree, call.expression, trees))?.ops;
          const diagnostic = fields.get("diagnostic");
          const partial =
            diagnostic &&
            ts.isPropertyAssignment(diagnostic) &&
            ts.isCallExpression(diagnostic.initializer) &&
            factories.get(
              callee(path, tree, diagnostic.initializer.expression, trees),
            )?.partial;
          if (
            fields.has("code") &&
            fields.has("message") &&
            !projectedInput &&
            !partial
          )
            report(
              node,
              "Unassigned structured error: use an approved HTTP factory, partial diagnostic or projectOpsFailure.",
            );
          if (fields.has("errorCode") && fields.has("errorMessage")) {
            if (
              !(
                ts.isCallExpression(call) &&
                ts.isPropertyAccessExpression(call.expression) &&
                call.expression.name.text === "recordFailed"
              ) &&
              !(
                projectedOpsField(fields.get("errorCode")) &&
                projectedOpsField(fields.get("errorMessage"))
              )
            )
              report(
                node,
                "Ops failure fields must pass through the Ops persistence boundary.",
              );
          }
        }
        if (
          ts.isBinaryExpression(node) &&
          ts.isPropertyAccessExpression(node.left) &&
          ["code", "errorCode"].includes(node.left.name.text) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        )
          report(
            node,
            "New coded exception requires an approved diagnostic surface.",
          );
        if (
          ts.isPropertyDeclaration(node) &&
          ["code", "errorCode"].includes(name(node.name))
        )
          report(
            node,
            "New coded exception requires an approved diagnostic surface.",
          );
        if (ts.isCallExpression(node)) {
          const factory = factories.get(
            callee(path, tree, node.expression, trees),
          );
          if (factory && !factory.ops) {
            const codeArg = node.arguments[factory.code];
            const statusArg = node.arguments[factory.status];
            const code =
              codeArg && ts.isStringLiteral(codeArg) ? codeArg.text : undefined;
            const status = statusArg
              ? statusName(path, tree, statusArg, trees)
              : (factory.defaultStatus ?? "");
            const messageArg = node.arguments[factory.message];
            if (
              !factory.safe &&
              (!messageArg ||
                !ts.isStringLiteral(messageArg) ||
                !reviewedMessages.has(messageArg.text))
            )
              report(
                node,
                "New domain factory message must be fixed reviewed copy; otherwise use createApiError for safe projection.",
              );
            const triage =
              (code &&
                /(?:INTERNAL|FINANCIAL|INTEGRITY|SCOPE_(?:MISMATCH|REPAIR)|CORRUPT|SETTLEMENT|TRANSACTION|WRITE_CONFLICT|PROVIDER|(?:PRICE|RATE|MARK|SOURCE)_(?:STALE|UNAVAILABLE)|COLLATERAL|MAINTENANCE|LIQUIDATION|BANKRUPTCY|RESERVATION_INVARIANT)/u.test(
                  code,
                )) ||
              /^(?:5\d\d|HttpStatus\.(?:INTERNAL_SERVER_ERROR|BAD_GATEWAY|SERVICE_UNAVAILABLE|GATEWAY_TIMEOUT))$/u.test(
                status,
              );
            const subject = `${path}#${owner(node)}`;
            const preauthEmitter = preauthSubjects.has(subject);
            if (
              triage &&
              (factory.opsMapped
                ? !opsContracts.has(`${subject}:${code}`)
                : preauthEmitter
                  ? !preauthContracts.has(subject)
                  : !code || !contracts.has(`${subject}:${code}`))
            )
              report(
                node,
                "Triage-required emitter needs a scoped actual diagnostic (or Public pre-auth / Ops) contract test.",
              );
            if (
              triage &&
              !factory.opsMapped &&
              !preauthEmitter &&
              !hasObservedStage(node)
            )
              report(
                node,
                "Triage-required emitter has no locally observed meaningful failure stage before emission.",
              );
            if (codeArg && !code && !factories.has(`${path}:${owner(node)}`)) {
              report(
                node,
                "Dynamic production code needs a fixed-code factory contract; do not hide emitters in expressions.",
              );
            }
          }
          if (
            ts.isPropertyAccessExpression(node.expression) &&
            ["json", "send"].includes(node.expression.name.text)
          ) {
            const receiver = node.expression.expression.getText(tree);
            if (/\b(?:res|response)\b/u.test(receiver))
              report(
                node,
                "Direct HTTP response bypasses the global exception filter.",
              );
          }
          if (
            ts.isPropertyAccessExpression(node.expression) &&
            ["error", "warn"].includes(node.expression.name.text) &&
            /logger|^console$/iu.test(
              node.expression.expression.getText(tree),
            ) &&
            node.arguments.some((a) =>
              /^(?:error|failure|err|payload)$|\.message\b|JSON\.stringify\((?:error|failure|payload)\)/u.test(
                a.getText(tree),
              ),
            )
          ) {
            report(
              node,
              "Project background/server failures safely; do not log raw exception text or payload.",
            );
          }
        }
      } else {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const imported = imports(tree).get(name(node.tagName));
          const target = imported && resolveImport(path, imported, trees);
          if (
            preauth &&
            target?.includes("/components/states/AdminDiagnosticPanel")
          )
            report(
              node,
              "Pre-auth workflows must not expose an admin diagnostic panel.",
            );
          const component = target?.includes(
            "/components/states/ErrorState.tsx:",
          )
            ? "ErrorState"
            : target?.includes("/components/states/ErrorNotice.tsx:")
              ? "ErrorNotice"
              : "";
          if (
            !preauth &&
            component &&
            !node.attributes.properties.some(
              (p) => ts.isJsxAttribute(p) && name(p.name) === "error",
            )
          ) {
            report(
              node,
              `${component} must receive the original error (use fixed copy alone only for non-error product state).`,
            );
          }
        }
        if (
          !preauth &&
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          /^set.*(?:Error|Failure|Message)$/u.test(node.expression.text) &&
          node.arguments.some(
            (a) =>
              ts.isCallExpression(a) &&
              /(?:Error.*Message|Message.*Error)/u.test(
                a.expression.getText(tree),
              ),
          )
        ) {
          report(
            node,
            "Keep the original error in local state; message-only state loses admin diagnostics.",
          );
        }
        if (
          !preauth &&
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          /^set.*(?:Error|Failure)$/u.test(node.expression.text)
        ) {
          let handler;
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (ts.isCatchClause(parent)) {
              handler = name(parent.variableDeclaration?.name);
              break;
            }
            if (ts.isFunctionLike(parent)) {
              handler = parent.parameters
                .map((p) => name(p.name))
                .find((p) => /^(?:error|failure|err)$/u.test(p));
              if (handler) break;
            }
          }
          if (
            handler &&
            node.arguments.some((a) => {
              if (name(a) === handler) return false;
              if (ts.isObjectLiteralExpression(a))
                return ![...properties(a).values()].some(
                  (p) =>
                    (ts.isShorthandPropertyAssignment(p) &&
                      name(p.name) === handler) ||
                    (ts.isPropertyAssignment(p) &&
                      name(p.initializer) === handler),
                );
              return true;
            })
          )
            report(
              node,
              "Authenticated failure handlers must retain the original error, including for fixed public copy.",
            );
        }
        if (
          !preauth &&
          ts.isCallExpression(node) &&
          callee(path, tree, node.expression, trees).endsWith(
            "/services/api/errorMapper.ts:getApiErrorDisplayMessage",
          ) &&
          path.endsWith(".tsx")
        )
          report(
            node,
            "New error presentation must use ErrorState/ErrorNotice with the original error.",
          );
        if (
          ts.isCallExpression(node) &&
          /\/services\/api\/errorMapper\.ts:getApiError(?:Code|Status|Info)$/u.test(
            callee(path, tree, node.expression, trees),
          )
        ) {
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (ts.isFunctionLike(parent)) break;
            if (!ts.isJsxExpression(parent)) continue;
            const attribute = ts.isJsxAttribute(parent.parent)
              ? parent.parent
              : undefined;
            if (
              attribute &&
              !["message", "title", "children"].includes(name(attribute.name))
            )
              break;
            const opening = attribute?.parent.parent;
            const imported =
              opening &&
              (ts.isJsxOpeningElement(opening) ||
                ts.isJsxSelfClosingElement(opening)) &&
              imports(tree).get(name(opening.tagName));
            const target = imported && resolveImport(path, imported, trees);
            if (
              !target ||
              !/\/components\/states\/Error(?:State|Notice)\.tsx:/u.test(target)
            )
              report(
                node,
                "Code-based public error copy must retain the original error in ErrorState/ErrorNotice.",
              );
            break;
          }
        }
        if (
          ts.isCallExpression(node) &&
          callee(path, tree, node.expression, trees).endsWith(
            "/services/api/errorMapper.ts:getApiErrorServerMessage",
          ) &&
          path.endsWith(".tsx")
        )
          report(
            node,
            "Raw server messages cannot become product copy; use the approved presentation boundary.",
          );
        if (
          ts.isPropertyAccessExpression(node) &&
          (["message", "serverMessage", "clientMessage"].includes(
            node.name.text,
          ) ||
            (["code", "status", "requestId", "failureStage"].includes(
              node.name.text,
            ) &&
              /\b(?:error|failure|err)\b/iu.test(
                node.expression.getText(tree),
              )))
        ) {
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (ts.isJsxExpression(parent)) {
              report(node, "Raw exception text is not product copy.");
              break;
            }
            if (ts.isFunctionLike(parent)) break;
          }
          if (
            ts.isCallExpression(node.parent) &&
            ts.isIdentifier(node.parent.expression) &&
            /^set.*(?:Error|Failure)$/u.test(node.parent.expression.text)
          )
            report(node, "Raw exception text is not product copy.");
        }
      }
    });
  }
  return violations;
}

function collectSources(root, scope) {
  const result = new Map();
  const scan = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "generated") scan(path);
      } else if (/\.tsx?$/u.test(entry.name))
        result.set(posix.relative(root, path), readFileSync(path, "utf8"));
    }
  };
  scan(resolve(root, scope, "src"));
  if (scope === "backend") scan(resolve(root, scope, "scripts/lib"));
  return result;
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
  execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], {
    cwd: root,
    stdio: "pipe",
  });
  const ts = createRequire(resolve(root, scope, "package.json"))("typescript");
  const current = collectSources(root, scope);
  const base = new Map();
  const paths = execFileSync(
    "git",
    [
      "ls-tree",
      "-r",
      "--name-only",
      baseRef,
      `${scope}/src`,
      `${scope}/scripts/lib`,
    ],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  for (const path of paths)
    if (/\.tsx?$/u.test(path) && !path.includes("/generated/")) {
      base.set(
        path,
        execFileSync("git", ["show", `${baseRef}:${path}`], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        }),
      );
    }
  return auditSources(ts, base, current, scope, true);
}

module.exports = { auditSources, runAudit };
if (require.main === module) {
  const root = resolve(__dirname, "..");
  const scope = process.argv[2];
  const violations = runAudit(root, scope);
  for (const issue of violations)
    process.stderr.write(`${issue.path}:${issue.line}: ${issue.rule}\n`);
  process.stdout.write(
    `Diagnostic AST gate (${scope}): ${violations.length ? "FAIL" : "PASS"}\n`,
  );
  process.exitCode = violations.length ? 1 : 0;
}
