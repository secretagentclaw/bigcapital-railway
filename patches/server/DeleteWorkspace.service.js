"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeleteWorkspaceService = void 0;
const common_1 = require("@nestjs/common");
const event_emitter_1 = require("@nestjs/event-emitter");
const ServiceError_1 = require("../../../Items/ServiceError");
const UserTenant_model_1 = require("../../../System/models/UserTenant.model");
const TenantModel_1 = require("../../../System/models/TenantModel");
const TenantDBManager_1 = require("../../../TenantDBManager/TenantDBManager");
const events_1 = require("../../../../common/events/events");
const Workspaces_constants_1 = require("../Workspaces.constants");
// System tables with a plain (non-cascading) FK to tenants.id in v0.25.44.
const TENANT_CHILD_TABLES = [
    'api_keys',
    'imports',
    'plaid_items',
    'user_invites',
    'subscription_plan_subscriptions',
];
let DeleteWorkspaceService = class DeleteWorkspaceService {
    constructor(userTenantModel, tenantModel, tenantDBManager, eventEmitter) {
        this.userTenantModel = userTenantModel;
        this.tenantModel = tenantModel;
        this.tenantDBManager = tenantDBManager;
        this.eventEmitter = eventEmitter;
    }
    /**
     * Deletes a workspace (organization). Only the owner may delete it.
     *
     * Patched for bigcapital-railway (upstream v0.25.44 dropped the tenant's
     * database first and then failed to delete the tenant row whenever a
     * child row without ON DELETE CASCADE still pointed at it, most often
     * an API key, leaving a listed workspace with no data that can never be
     * deleted). Order here:
     *   1. In one system-DB transaction, remove every child row that has a
     *      plain FK to tenants, clear users' legacy/default pointers, and
     *      delete the tenant row (user_tenants cascades).
     *   2. While that transaction is still open, drop the tenant database.
     *   3. Commit. If any step fails the transaction rolls back, the
     *      workspace keeps its data, and is_deleting is cleared so the owner
     *      can try again.
     */
    async deleteWorkspace(userId, organizationId) {
        const tenant = await this.tenantModel.query().findOne({ organizationId });
        if (!tenant) {
            throw new ServiceError_1.ServiceError(Workspaces_constants_1.WorkspacesError.WORKSPACE_NOT_FOUND, 'Workspace not found');
        }
        const membership = await this.userTenantModel
            .query()
            .findOne({ userId, tenantId: tenant.id });
        if (!membership || membership.role !== 'owner') {
            throw new ServiceError_1.ServiceError(Workspaces_constants_1.WorkspacesError.NOT_WORKSPACE_OWNER, 'Only the workspace owner can delete it');
        }
        const databaseName = this.tenantDBManager.getDatabaseName(tenant);
        const systemKnex = this.tenantDBManager.systemKnex;
        try {
            await systemKnex.transaction(async (trx) => {
                for (const table of TENANT_CHILD_TABLES) {
                    await trx(table).where('tenant_id', tenant.id).del();
                }
                await trx('users').where('tenant_id', tenant.id).update({ tenant_id: null });
                await trx('users').where('default_tenant_id', tenant.id).update({ default_tenant_id: null });
                await trx('tenants_metadata').where('tenant_id', tenant.id).del();
                const deleted = await this.tenantModel.query(trx).deleteById(tenant.id);
                if (deleted !== 1) {
                    throw new Error(`Expected to delete 1 tenant row, deleted ${deleted}`);
                }
                // Only now drop the data. This runs on its own connection;
                // if it throws, the transaction above rolls back.
                await systemKnex.raw(`DROP DATABASE IF EXISTS \`${databaseName}\``);
            });
        }
        catch (error) {
            await this.tenantModel
                .query()
                .findById(tenant.id)
                .patch({ isDeleting: false })
                .catch(() => undefined);
            throw error;
        }
        await this.eventEmitter.emitAsync(events_1.events.workspace.deleted, {
            organizationId,
            userId,
            tenantId: tenant.id,
        });
    }
};
exports.DeleteWorkspaceService = DeleteWorkspaceService;
exports.DeleteWorkspaceService = DeleteWorkspaceService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(UserTenant_model_1.UserTenant.name)),
    __param(1, (0, common_1.Inject)(TenantModel_1.TenantModel.name)),
    __metadata("design:paramtypes", [Object, Object, TenantDBManager_1.TenantDBManager,
        event_emitter_1.EventEmitter2])
], DeleteWorkspaceService);
