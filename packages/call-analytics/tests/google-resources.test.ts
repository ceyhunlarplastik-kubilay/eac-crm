import test from "node:test";
import assert from "node:assert/strict";
import { ensureListedResource, federationResourceIds } from "../scripts/google-resources";

const list = ["iam", "workload-identity-pools", "providers", "list"];
const create = ["iam", "workload-identity-pools", "providers", "create-aws", "aws-provider"];
const provider = { name: "projects/123/locations/global/workloadIdentityPools/eac-crm-kubi/providers/aws-provider", state: "ACTIVE" };

test("first-time provider setup lists the parent and creates the missing provider without describe", async () => {
  const calls: string[][] = [];
  await ensureListedResource(async (args) => {
    calls.push(args);
    if (args.includes("describe")) throw new Error("PERMISSION_DENIED (or it may not exist)");
    return args.includes("list") ? "[]" : "created";
  }, list, "aws-provider", create);
  assert.deepEqual(calls, [[...list, "--format=json"], create]);
});

test("re-running setup reuses an existing provider", async () => {
  const calls: string[][] = [];
  await ensureListedResource(async (args) => { calls.push(args); return JSON.stringify([provider]); }, list, "aws-provider", create);
  assert.equal(calls.length, 1);
});

test("a real permission denial is surfaced without attempting creation", async () => {
  const calls: string[][] = [];
  await assert.rejects(() => ensureListedResource(async (args) => {
    calls.push(args); throw new Error("PERMISSION_DENIED: iam.workloadIdentityPoolProviders.list");
  }, list, "aws-provider", create), /PERMISSION_DENIED/);
  assert.equal(calls.length, 1);
});

test("deleted provider IDs and malformed lists cannot cause accidental creation", async () => {
  for (const response of [JSON.stringify([{ ...provider, state: "DELETED" }]), "{}", JSON.stringify([{}])]) {
    const calls: string[][] = [];
    await assert.rejects(() => ensureListedResource(async (args) => { calls.push(args); return response; }, list, "aws-provider", create));
    assert.equal(calls.length, 1);
  }
});

test("concurrent creation succeeds only after the provider is visible in a fresh list", async () => {
  let lists = 0;
  await ensureListedResource(async (args) => {
    if (args.includes("list")) return JSON.stringify(lists++ ? [provider] : []);
    throw new Error("ALREADY_EXISTS: requested entity already exists");
  }, list, "aws-provider", create);
  assert.equal(lists, 2);
  await assert.rejects(() => ensureListedResource(async (args) => {
    if (args.includes("list")) return "[]";
    throw new Error("ALREADY_EXISTS: requested entity already exists");
  }, list, "aws-provider", create), /ALREADY_EXISTS/);
});

// Google validates these IDs at creation; mocks must use the same production configuration.
test("both stage configurations use valid Google pool/provider IDs before any API mutation", () => {
  for (const stage of ["kubi", "production"]) {
    const ids = federationResourceIds(stage);
    assert.equal(ids.pool, `eac-crm-${stage}`);
    assert.equal(ids.provider, "aws-provider");
    for (const id of [ids.pool, ids.provider]) {
      assert.ok(id.length >= 4 && id.length <= 32);
      assert.match(id, /^[a-z0-9-]+$/);
      assert.equal(id.startsWith("gcp-"), false);
    }
    assert.equal(ids.serviceAccountId, `eac-crm-${stage}-analytics`);
  }
  assert.throws(() => federationResourceIds("unknown"), /stage/);
});
