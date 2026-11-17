// Unit tests for patches/server/DeleteWorkspace.service.js.
// The patched file is loaded with its relative imports stubbed, against a
// fake system knex that records every statement and models a transaction.
require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

class ServiceError extends Error {
  constructor(errorType, message) { super(message); this.errorType = errorType; }
}
const stubs = {
  '../../../Items/ServiceError': { ServiceError },
  '../../../System/models/UserTenant.model': { UserTenant: { name: 'UserTenant' } },
  '../../../System/models/TenantModel': { TenantModel: { name: 'TenantModel' } },
  '../../../TenantDBManager/TenantDBManager': { TenantDBManager: class TenantDBManager {} },
  '../../../../common/events/events': { events: { workspace: { deleted: 'onWorkspaceDeleted' } } },
  '../Workspaces.constants': {
    WorkspacesError: { WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND', NOT_WORKSPACE_OWNER: 'NOT_WORKSPACE_OWNER' },
  },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  // The patch lives outside test/, so resolve its packages from here.
  if (request.startsWith('@nestjs/')) return realLoad.call(this, require.resolve(request), parent, isMain);
  return realLoad.call(this, request, parent, isMain);
};
const { DeleteWorkspaceService } = require(path.join(__dirname, '..', 'patches', 'server', 'DeleteWorkspace.service.js'));

const TENANT = { id: 4, organizationId: 'org4' };

function setup({ role = 'owner', failOn = null, deletedRows = 1 } = {}) {
  const log = [];
  const state = { committed: false, rolledBack: false, isDeletingReset: false };
  const maybeFail = (what) => { if (failOn === what) throw new Error(`boom: ${what}`); };

  const trx = (table) => {
    const b = { table, where: {} };
    b.where = (col, val) => { b.cond = `${col}=${val}`; return b; };
    b.del = async () => { log.push(`trx delete ${table} ${b.cond}`); maybeFail(`delete ${table}`); return 0; };
    b.update = async (v) => { log.push(`trx update ${table} ${b.cond} ${JSON.stringify(v)}`); return 0; };
    return b;
  };
  const systemKnex = {
    async transaction(cb) {
      log.push('BEGIN');
      try { const r = await cb(trx); state.committed = true; log.push('COMMIT'); return r; }
      catch (e) { state.rolledBack = true; log.push('ROLLBACK'); throw e; }
    },
    async raw(sql) { log.push(`raw ${sql}`); maybeFail('drop'); },
  };
  const tenantModel = {
    query(t) {
      return {
        findOne: async () => TENANT,
        deleteById: async (id) => {
          log.push(`${t === trx ? 'trx' : 'NO-TRX'} delete tenants id=${id}`);
          maybeFail('delete tenants');
          return deletedRows;
        },
        findById: () => ({ patch: async (v) => { log.push(`patch tenants ${JSON.stringify(v)}`); state.isDeletingReset = v.isDeleting === false; } }),
      };
    },
  };
  const userTenantModel = { query: () => ({ findOne: async () => (role ? { role } : null) }) };
  const tenantDBManager = {
    systemKnex,
    getDatabaseName: (t) => `bigcapital_tenant_${t.organizationId}`,
    dropDatabaseIfExists: async () => { log.push('LEGACY dropDatabaseIfExists'); },
  };
  const events = [];
  const eventEmitter = { emitAsync: async (name, p) => events.push([name, p]) };
  const svc = new DeleteWorkspaceService(userTenantModel, tenantModel, tenantDBManager, eventEmitter);
  return { svc, log, state, events };
}

test('removes FK children and the tenant row before dropping the data, all in one transaction', async () => {
  const { svc, log, state, events } = setup();
  await svc.deleteWorkspace(1, 'org4');
  assert.deepEqual(log, [
    'BEGIN',
    'trx delete api_keys tenant_id=4',
    'trx delete imports tenant_id=4',
    'trx delete plaid_items tenant_id=4',
    'trx delete user_invites tenant_id=4',
    'trx delete subscription_plan_subscriptions tenant_id=4',
    'trx update users tenant_id=4 {"tenant_id":null}',
    'trx update users default_tenant_id=4 {"default_tenant_id":null}',
    'trx delete tenants_metadata tenant_id=4',
    'trx delete tenants id=4',
    'raw DROP DATABASE IF EXISTS `bigcapital_tenant_org4`',
    'COMMIT',
  ]);
  assert.equal(state.committed, true);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'onWorkspaceDeleted');
});

test('a tenant-row FK failure never drops the data and clears is_deleting', async () => {
  const { svc, log, state, events } = setup({ failOn: 'delete tenants' });
  await assert.rejects(svc.deleteWorkspace(1, 'org4'), /boom: delete tenants/);
  assert.ok(!log.some((l) => l.startsWith('raw DROP')), 'no DROP DATABASE');
  assert.ok(!log.includes('LEGACY dropDatabaseIfExists'));
  assert.equal(state.rolledBack, true);
  assert.equal(state.isDeletingReset, true);
  assert.equal(events.length, 0);
});

test('a child-row failure (e.g. api_keys) never drops the data', async () => {
  const { svc, log, state } = setup({ failOn: 'delete api_keys' });
  await assert.rejects(svc.deleteWorkspace(1, 'org4'));
  assert.ok(!log.some((l) => l.startsWith('raw DROP')));
  assert.ok(!log.some((l) => l.includes('delete tenants id')));
  assert.equal(state.rolledBack, true);
  assert.equal(state.isDeletingReset, true);
});

test('if the database drop fails the row deletes roll back and the workspace stays deletable', async () => {
  const { svc, state, events } = setup({ failOn: 'drop' });
  await assert.rejects(svc.deleteWorkspace(1, 'org4'), /boom: drop/);
  assert.equal(state.committed, false);
  assert.equal(state.rolledBack, true);
  assert.equal(state.isDeletingReset, true);
  assert.equal(events.length, 0);
});

test('deleting zero tenant rows is treated as a failure, not success', async () => {
  const { svc, log, state } = setup({ deletedRows: 0 });
  await assert.rejects(svc.deleteWorkspace(1, 'org4'), /Expected to delete 1 tenant row/);
  assert.ok(!log.some((l) => l.startsWith('raw DROP')));
  assert.equal(state.rolledBack, true);
});

test('a non-owner is refused with a readable message and nothing is written', async () => {
  const { svc, log } = setup({ role: 'member' });
  await assert.rejects(svc.deleteWorkspace(1, 'org4'), (e) =>
    e.errorType === 'NOT_WORKSPACE_OWNER' && /owner/.test(e.message));
  assert.deepEqual(log, []);
});
