const { auditSources } = require("./diagnostic-enforcement.cjs");

// In-memory snippets only. Real repository reads belong to the dedicated CI gate.
module.exports = function enforcementFixtures(ts, assert, scope) {
  const path =
    scope === "backend"
      ? "backend/src/feature/feature.service.ts"
      : "frontend/src/screens/feature/FeatureScreen.tsx";
  const source = (text, file = path) => new Map([[file, text]]);
  const check = (text, expected, file = path) => {
    const issues = auditSources(ts, new Map(), source(text, file), scope);
    if (expected)
      assert.ok(
        issues.some((issue) => issue.rule.includes(expected)),
        `${expected}: ${text}`,
      );
    else assert.deepEqual(issues, [], text);
  };
  if (scope === "backend") {
    check(
      "import {HttpException as E} from '@nestjs/common'; throw new E({error:{code:'NEW',message:raw}},500);",
      "direct exceptions",
    );
    check(
      "import * as nest from '@nestjs/common'; throw new nest.BadRequestException(raw);",
      "direct exceptions",
    );
    check(
      "response.status(503).json({error:{code:'NEW',message:raw}});",
      "Direct HTTP",
    );
    check("return {code:'NEW',message:raw};", "Unassigned");
    check("class NewFailure extends Error { code = 'NEW'; }", "coded error");
    check("error.code = 'NEW';", "coded error");
    check("throw new Error(raw);", "Raw error emitter");
    check("logger.error(error);", "Do not log raw");
    check("this.logger.warn(error.message);", "Do not log raw");
    check("console.log(JSON.stringify(payload));", "Do not log raw");
    check(
      "db.opsJobRun.update({data:{errorCode:err.code,errorMessage:err.message}});",
      "Ops failure fields",
    );
    check(
      "import {createApiError as fail} from '../common/api-error'; throw fail('NEW_PROVIDER_FAILURE',raw,503);",
    );
    check(
      "import {projectOpsFailure as project} from '../ops/ops-failure'; return project(error,'FIXED_DOMAIN_FAILURE');",
    );
    check(
      "import {projectOpsFailure} from '../ops/ops-failure'; return projectOpsFailure({code:raw,message:raw});",
    );
    check(
      "import {projectOpsFailure} from '../ops/ops-failure'; return projectOpsFailure(new Error(raw));",
    );
    check(
      "runService.recordFailed(run,{errorCode:'FIXED_DOMAIN_FAILURE',errorMessage:raw});",
    );
    check(
      "import {projectOpsFailure} from '../ops/ops-failure'; const projected=projectOpsFailure(error); db.opsJobRun.update({data:{errorCode:projected.code,errorMessage:projected.message}});",
    );
    check(
      "const projected=error; db.opsJobRun.update({data:{errorCode:projected.code,errorMessage:projected.message}});",
      "Ops failure fields",
    );
    check(
      "import {safeAdminDiagnosticLog as safe} from '../common/admin-diagnostics'; logger.error(safe({failure:error}));",
    );
    check(
      "import {classifyFailureCause} from '../common/safe-failure-cause'; logger.error(classifyFailureCause(error));",
    );
    check(
      "// @diagnosticSurface internal: impossible local invariant, reviewed here\nthrow new Error('invariant');",
    );
    check(
      "import {buildAdminPartialFailureDiagnostic as partial} from '../common/admin-diagnostics'; return {code:'NEW',message:fixed,diagnostic:partial(error,'NEW')};",
    );
    // No route registry, lexical stage proof, factory graph or test-name matching.
    check(
      "import {Get} from '@nestjs/common'; class Feature { @Get() read(){ return service.read(); } }",
    );
    check(
      "import {domainError} from './domain'; function action(){ throw domainError(code, message); }",
    );
  } else {
    const state = "import State from '../../components/states/ErrorState';";
    const notice =
      "import {ErrorNotice as Notice} from '../../components/states/ErrorNotice';";
    const mapper =
      "import {getApiErrorDisplayMessage as display} from '../../services/api/errorMapper';";
    check(`${state} return <State message='safe'/>;`, "original error");
    check(`${notice} return <Notice message='safe'/>;`, "original error");
    check(`${state} return <State error={undefined}/>;`, "original error");
    check(`${state} return <State {...props}/>;`, "original error");
    check(
      `${state} return <State error={query.error} onRetry={query.refetch}/>;`,
    );
    check(`${notice} return <Notice error={error} message='Try again.'/>;`);
    check("return <Text>{error.message}</Text>;", "Raw exception");
    check("return <Text>{query.error?.code}</Text>;", "Raw exception");
    check("return <Text>{error.response.status}</Text>;", "Raw exception");
    check("return <Text>{info.serverMessage}</Text>;", "Raw exception");
    check("return <Text>{serverMessage}</Text>;", "Raw server message");
    check(
      "import {getApiErrorServerMessage as raw} from '../../services/api/errorMapper'; return <Text>{raw(error)}</Text>;",
      "Raw error mapper",
    );
    check(`${mapper} setFailure(display(error));`, "original error");
    check(`${mapper} setFailure({error, message:display(error)});`);
    check(`${mapper} const publicCopy=display(error); return null;`);
    const auth = "frontend/src/screens/auth/LoginScreen.tsx";
    check(
      "import Panel from '../../components/states/AdminDiagnosticPanel'; return <Panel diagnostic={value}/>;",
      "Pre-auth",
      auth,
    );
    check(`${mapper} setError(display(error));`, undefined, auth);
    check("setError(error.message);", "Raw exception", auth);
    // Deliberately outside static coverage: review/screen tests own arbitrary UI.
    check("if (query.isError) return <Text>Try again.</Text>;");
    const before = source("const text = error.message; return null;");
    assert.ok(
      auditSources(
        ts,
        before,
        source("return <Text>{error.message}</Text>;"),
        scope,
      ).length,
    );
  }
  const bad =
    scope === "backend"
      ? "logger.error(error);"
      : "return <Text>{error.message}</Text>;";
  const before = source(bad);
  assert.deepEqual(auditSources(ts, before, before, scope), []);
  assert.deepEqual(
    auditSources(ts, before, source(`\n ${bad} // reformat\n`), scope),
    [],
  );
  assert.ok(
    auditSources(ts, before, source(`${bad}\n${bad}`), scope).length,
    "duplicate bypass is new",
  );
  assert.deepEqual(
    auditSources(
      ts,
      new Map(),
      source(bad, `${scope}/src/feature/example.test.ts`),
      scope,
    ),
    [],
  );
  assert.deepEqual(
    auditSources(
      ts,
      new Map(),
      source(bad, `${scope}/src/generated/example.ts`),
      scope,
    ),
    [],
  );
};
