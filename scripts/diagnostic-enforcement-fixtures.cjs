const { auditSources } = require("./diagnostic-enforcement.cjs");

module.exports = function enforcementFixtures(ts, assert) {
  const backend = (source) =>
    new Map([
      [
        "backend/src/common/api-error.ts",
        "export function createApiError(code: string, message: string, status: number) {}",
      ],
      [
        "backend/src/ops/ops-failure.ts",
        "export function projectOpsFailure(error: unknown) {}",
      ],
      [
        "backend/src/common/admin-diagnostics.ts",
        "export function setAdminDiagnosticContext(update) {}",
      ],
      [
        "backend/scripts/lib/diagnostic-quality.ts",
        "export function assertDiagnosticTriage(d, code, subject) {} export function assertDiagnosticBaseline(d, subject) {} export function assertPreAuthFailure(body, subject, logs) {} export function assertOpsFailure(result, code, subject) {}",
      ],
      ["backend/src/feature/feature.service.ts", source],
    ]);
  const frontend = (source) =>
    new Map([
      [
        "frontend/src/components/states/ErrorState.tsx",
        "export default function ErrorState() {}",
      ],
      [
        "frontend/src/components/states/ErrorNotice.tsx",
        "export default function ErrorNotice() {}",
      ],
      [
        "frontend/src/services/api/errorMapper.ts",
        "export function getApiErrorDisplayMessage(error: unknown) {} export function getApiErrorCode(error: unknown) {}",
      ],
      ["frontend/src/screens/feature/FeatureScreen.tsx", source],
    ]);
  const failures = (map, scope) =>
    auditSources(ts, new Map(), map, scope).map((issue) => issue.rule);
  const apiImport =
    "import { createApiError as fail } from '../common/api-error';";
  assert.deepEqual(
    failures(
      backend(
        `${apiImport} export function action() { throw fail('NEW_SYNTHETIC_ERROR', 'safe fixed copy', 409); }`,
      ),
      "backend",
    ),
    [],
  );
  assert.ok(
    failures(
      backend(
        "import { HttpException as E } from '@nestjs/common'; export function action() { throw new E({success:false,error:{code:'NEW',message:privateMessage}},500); }",
      ),
      "backend",
    ).some((rule) => rule.includes("direct exceptions")),
  );
  assert.ok(
    failures(
      backend(
        "export function action(res) { return res.status(503).json({error:{code:'NEW',message:'private'}}); }",
      ),
      "backend",
    ).some((rule) => rule.includes("Direct HTTP")),
  );
  assert.ok(
    failures(
      backend(
        "export function job() { return {code:'NEW_BACKGROUND_CODE',message:raw}; }",
      ),
      "backend",
    ).some((rule) => rule.includes("Unassigned")),
  );
  assert.ok(
    failures(
      backend("class NewFailure extends Error { code = 'NEW_FAILURE'; }"),
      "backend",
    ).some((rule) => rule.includes("coded exception")),
  );
  assert.ok(
    failures(
      backend(
        `${apiImport} export function action() { throw fail('NEW_PROVIDER_FAILURE','safe',503); }`,
      ),
      "backend",
    ).some((rule) => rule.includes("Triage-required")),
  );
  const stage =
    "import {setAdminDiagnosticContext as observed} from '../common/admin-diagnostics';";
  assert.ok(
    failures(
      backend(
        `${apiImport} import {HttpStatus as S} from '@nestjs/common'; function action() { throw fail('NEW_SIMPLE_ERROR','safe',S.SERVICE_UNAVAILABLE); }`,
      ),
      "backend",
    ).some((rule) => rule.includes("Triage-required")),
  );
  assert.ok(
    failures(
      backend(
        "function job(result) { result.errorCode = 'NEW_BACKGROUND_CODE'; }",
      ),
      "backend",
    ).some((rule) => rule.includes("coded exception")),
  );
  const approvedTriage = backend(
    `${apiImport} ${stage} export function action() { observed({failureStage:'provider_fetch'}); throw fail('NEW_PROVIDER_FAILURE','safe',503); }`,
  );
  approvedTriage.set(
    "backend/src/feature/feature.spec.ts",
    "import { assertDiagnosticTriage as check } from '../../scripts/lib/diagnostic-quality'; check(actualDiagnostic, 'NEW_PROVIDER_FAILURE', 'backend/src/feature/feature.service.ts#action');",
  );
  assert.deepEqual(failures(approvedTriage, "backend"), []);
  const unenriched = new Map(approvedTriage);
  unenriched.set(
    "backend/src/feature/feature.service.ts",
    `${apiImport} export function action() { throw fail('NEW_PROVIDER_FAILURE','safe',503); }`,
  );
  assert.ok(
    failures(unenriched, "backend").some((rule) =>
      rule.includes("observed meaningful"),
    ),
  );
  const anotherPath = new Map(approvedTriage);
  anotherPath.set(
    "backend/src/feature/feature.service.ts",
    `${apiImport} ${stage} export function another() { observed({failureStage:'provider_fetch'}); throw fail('NEW_PROVIDER_FAILURE','safe',503); }`,
  );
  assert.ok(
    failures(anotherPath, "backend").some((rule) =>
      rule.includes("scoped actual"),
    ),
  );
  assert.deepEqual(
    failures(
      backend(
        "import { projectOpsFailure } from '../ops/ops-failure'; export function job(error) { return projectOpsFailure(error); }",
      ),
      "backend",
    ),
    [],
  );
  const opsFactory = backend(
    "import {HttpException} from '@nestjs/common'; function jobError(code:string,message:string,resultPayloadJson:unknown) { return new HttpException({error:{code,message},data:{resultPayloadJson}},503); }",
  );
  const opsPath = new Map(opsFactory);
  opsPath.set(
    "backend/src/common/safe-diagnostic-message.ts",
    "const SAFE_MESSAGES = new Set(['Background operation failed.']);",
  );
  opsPath.set(
    "backend/src/feature/feature.service.ts",
    `${opsFactory.get("backend/src/feature/feature.service.ts")} function job() { throw jobError('NEW_PROVIDER_FAILURE','Background operation failed.',result); }`,
  );
  assert.ok(
    auditSources(ts, opsFactory, opsPath, "backend").some((issue) =>
      issue.rule.includes("scoped actual"),
    ),
  );
  opsPath.set(
    "backend/src/feature/feature.spec.ts",
    "import {assertOpsFailure} from '../../scripts/lib/diagnostic-quality'; assertOpsFailure(actual, 'NEW_PROVIDER_FAILURE', 'backend/src/feature/feature.service.ts#job');",
  );
  assert.deepEqual(auditSources(ts, opsFactory, opsPath, "backend"), []);
  assert.ok(
    failures(
      backend("export function invariant() { throw new Error(raw); }"),
      "backend",
    ).length,
  );
  assert.deepEqual(
    failures(
      backend(
        'export function invariant() { // @diagnosticSurface internal: impossible in-memory invariant; no production code\n throw new Error("invariant"); }',
      ),
      "backend",
    ),
    [],
  );
  const uiImport = "import State from '../../components/states/ErrorState';";
  assert.deepEqual(
    failures(
      frontend(
        `${uiImport} export function Screen() { return <State error={query.error} />; }`,
      ),
      "frontend",
    ),
    [],
  );
  assert.ok(
    failures(
      frontend(
        `${uiImport} export function Screen() { return <State message="safe" onRetry={query.refetch} />; }`,
      ),
      "frontend",
    ).some((rule) => rule.includes("original error")),
  );
  assert.ok(
    failures(
      frontend(
        "import {getApiErrorDisplayMessage as message} from '../../services/api/errorMapper'; export function Screen() { setFailure(message(error)); return <Text>{message(error)}</Text>; }",
      ),
      "frontend",
    ).length,
  );
  assert.ok(
    failures(
      frontend(
        "export function Screen() { return <Text>{error.message}</Text>; }",
      ),
      "frontend",
    ).some((rule) => rule.includes("Raw exception")),
  );
  assert.ok(
    failures(
      frontend(
        "export function Screen() { return <Text>{query.error?.code}</Text>; }",
      ),
      "frontend",
    ).some((rule) => rule.includes("Raw exception")),
  );
  const preauth = new Map([
    [
      "frontend/src/screens/auth/LoginScreen.tsx",
      "setError(getApiErrorDisplayMessage(error));",
    ],
  ]);
  assert.deepEqual(failures(preauth, "frontend"), []);
  preauth.set(
    "frontend/src/screens/auth/LoginScreen.tsx",
    "setError(error.message);",
  );
  assert.ok(failures(preauth, "frontend").length);
  const newRoute = backend("");
  newRoute.set(
    "backend/src/feature/feature.controller.ts",
    "import {Get} from '@nestjs/common'; class Feature { @Get('read') read() { return service.read(); } }",
  );
  assert.ok(
    failures(newRoute, "backend").some((rule) => rule.includes("HTTP handler")),
  );
  newRoute.set(
    "backend/src/feature/feature.spec.ts",
    "import {assertDiagnosticBaseline} from '../../scripts/lib/diagnostic-quality'; assertDiagnosticBaseline(actual, 'backend/src/feature/feature.controller.ts#read');",
  );
  assert.deepEqual(failures(newRoute, "backend"), []);
  const migratedFactory = backend(
    "import {createApiError} from '../common/api-error'; export function domainError(code:string,message:string,status:number) { throw createApiError(code,message,status); }",
  );
  const nextFeature = new Map(migratedFactory);
  nextFeature.set(
    "backend/src/feature/new.service.ts",
    "import {domainError} from './feature.service'; export function action() { domainError('NEXT_SYNTHETIC_CODE', raw, 409); }",
  );
  assert.deepEqual(
    auditSources(ts, migratedFactory, nextFeature, "backend"),
    [],
  );
  assert.deepEqual(failures(nextFeature, "backend"), []);
  const privateRead = frontend(
    "export function Screen() { const text = error.message; return null; }",
  );
  const visibleRead = frontend(
    "export function Screen() { return <Text>{error.message}</Text>; }",
  );
  assert.ok(
    auditSources(ts, privateRead, visibleRead, "frontend").some((issue) =>
      issue.rule.includes("Raw exception"),
    ),
  );
  const codeCopy =
    "import {getApiErrorCode} from '../../services/api/errorMapper';";
  assert.ok(
    failures(
      frontend(
        `${codeCopy} function Screen() { return <Text>{domainMessage(getApiErrorCode(error))}</Text>; }`,
      ),
      "frontend",
    ).some((rule) => rule.includes("Code-based")),
  );
  assert.deepEqual(
    failures(
      frontend(
        `${codeCopy} import Notice from '../../components/states/ErrorNotice'; function Screen() { return <Notice error={error} message={domainMessage(getApiErrorCode(error))} />; }`,
      ),
      "frontend",
    ),
    [],
  );
  // Reformatting does not create an emitter; adding an identical second emitter does.
  const before = backend(
    "import {HttpException} from '@nestjs/common'; function a() { throw new HttpException('x',400); }",
  );
  const after = backend(
    "import { HttpException } from '@nestjs/common';\nfunction a(){\nthrow new HttpException('x', 400);\n}",
  );
  assert.deepEqual(auditSources(ts, before, after, "backend"), []);
  after.set(
    "backend/src/feature/feature.service.ts",
    "import {HttpException} from '@nestjs/common'; function a(){ throw new HttpException('x',400); throw new HttpException('x',400); }",
  );
  assert.ok(auditSources(ts, before, after, "backend").length);
};
