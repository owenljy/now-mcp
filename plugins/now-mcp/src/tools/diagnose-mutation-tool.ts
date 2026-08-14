import {
	DiagnoseMutationOutputSchema,
	DiagnoseMutationSchema,
} from '../schemas/mutation-diagnostic-schemas.js';
import type { ScriptService } from '../services/script-service.js';
import { toolError } from '../utils/error-handler.js';
import { toolResult } from '../utils/tool-response.js';

export const DIAGNOSE_MUTATION_TOOL = {
	name: 'sn_diagnose_mutation',
	title: 'Diagnose blocked mutation',
	description: `What: Read-only diagnostics for a record update/delete: runtime canWrite/canDelete, requested field writability, active before business rules (including abort-capable rules), effective ACL coverage (including parent-table and wildcard ACLs), and inbound reference counts.
When to use: Before changing ACLs or disabling business rules when an update/delete was denied, returned null/false, or failed read-after-write verification.
Preconditions: Elevated access to the target and security metadata. Uses the background-script transport, but the diagnostic script itself performs no writes.
	Limitations: This identifies likely blockers; it does not execute a dry-run mutation and cannot prove which rule would abort for a specific proposed value. ACL scripts are reported, not evaluated individually. If security metadata cannot be read, ACL coverage is reported as unknown rather than absent.
	WHOSE ACCESS: every capability here is evaluated as the background-script identity (reported in \`identity\` — typically \`system\`, admin + snc_internal), NOT as the REST user the other tools write with. Measured on a live instance: sys_security_acl is canWrite=false for the API user and RWCD under the background script. So this tool can report a write will succeed when the API user cannot perform it, and the reverse. For the API user's verdict use sn_get_security_info (effectiveAccess), or preflightAccess: true on the write itself.`,
	inputSchema: DiagnoseMutationSchema,
	outputSchema: DiagnoseMutationOutputSchema,
};

export function createDiagnoseMutationTool(scriptService: ScriptService) {
	return {
		...DIAGNOSE_MUTATION_TOOL,
		handler: async (params: unknown) => {
			try {
				const v = DiagnoseMutationSchema.parse(params);
				const script = `(function(){
	var out={identity:{},recordExists:false,capabilities:{},fieldCapabilities:[],activeBusinessRules:[],applicableAcls:[],aclCoverage:{metadataReadable:false,coverage:'unknown'},referenceDependencies:[]};
	// Report WHO this ran as. Every canRead/canWrite below is that user's answer,
	// and the background-script identity is not the REST user the write tools use.
	try{out.identity={userName:String(gs.getUserName()||''),userId:String(gs.getUserID()||''),isAdmin:gs.hasRole('admin')};}catch(identityError){out.identity={error:String(identityError)};}
	var table=${JSON.stringify(v.tableName)}, id=${JSON.stringify(v.sysId)}, requestedOp=${JSON.stringify(v.operation)}, fields=${JSON.stringify(v.fields)};
	var aclOp=requestedOp==='update'?'write':requestedOp;
var rec=new GlideRecordSecure(table); out.recordExists=rec.get(id);
if(out.recordExists){out.capabilities={canRead:rec.canRead(),canWrite:rec.canWrite(),canDelete:rec.canDelete(),sysClassName:String(rec.getValue('sys_class_name')||table)};
for(var i=0;i<fields.length;i++){var el=rec.getElement(fields[i]);out.fieldCapabilities.push({field:fields[i],exists:!!el,canRead:!!el&&el.canRead(),canWrite:!!el&&el.canWrite(),value:el&&el.canRead()?String(el.getValue()||''):null});}}
var br=new GlideRecord('sys_script');br.addQuery('collection',table);br.addQuery('active',true);br.addQuery('when','before');br.query();while(br.next()){var s=String(br.getValue('script')||'');out.activeBusinessRules.push({sys_id:String(br.getUniqueValue()),name:String(br.getValue('name')),order:String(br.getValue('order')||''),update:String(br.getValue('action_update')||''),delete:String(br.getValue('action_delete')||''),hasAbort:s.indexOf('setAbortAction')>=0,condition:String(br.getValue('filter_condition')||'')});}
	var hierarchy=[table], cursor=table, seen={};seen[table]=true;
	try{while(cursor){var dbo=new GlideRecord('sys_db_object');if(!dbo.get('name',cursor))break;var parent=String(dbo.getValue('super_class')||'');if(!parent)break;var parentObj=new GlideRecord('sys_db_object');if(!parentObj.get(parent))break;cursor=String(parentObj.getValue('name')||'');if(!cursor||seen[cursor])break;seen[cursor]=true;hierarchy.push(cursor);}}catch(ignoreHierarchy){}
	var names=[], nameSeen={};function addName(n){if(n&&!nameSeen[n]){nameSeen[n]=true;names.push(n);}}
	for(var h=0;h<hierarchy.length;h++){addName(hierarchy[h]);addName(hierarchy[h]+'.*');for(var f=0;f<fields.length;f++)addName(hierarchy[h]+'.'+fields[f]);}
	addName('*');for(var wf=0;wf<fields.length;wf++)addName('*.'+fields[wf]);
	try{
	 var probe=new GlideRecordSecure('sys_security_acl');probe.addQuery('active',true);probe.setLimit(1);probe.query();out.aclCoverage.metadataReadable=probe.hasNext();
	 if(out.aclCoverage.metadataReadable){var acl=new GlideRecordSecure('sys_security_acl');acl.addQuery('active',true);acl.addQuery('operation',aclOp);acl.addQuery('name','IN',names.join(','));acl.query();while(acl.next()){var aclId=String(acl.getUniqueValue()),aclName=String(acl.getValue('name')),roles=[];var ar=new GlideRecordSecure('sys_security_acl_role');ar.addQuery('sys_security_acl',aclId);ar.query();while(ar.next()){var role=ar.getElement('sys_user_role');roles.push(String(role.getDisplayValue()||role.getValue()||''));}out.applicableAcls.push({sys_id:aclId,name:aclName,operation:String(acl.getValue('operation')),roles:roles,hasCondition:!acl.getElement('condition').nil(),hasScript:!acl.getElement('script').nil(),inherited:aclName.indexOf(table)!==0,wildcard:aclName.indexOf('*')>=0});}}
	}catch(aclError){out.aclCoverage.metadataError=String(aclError);out.aclCoverage.metadataReadable=false;}
	var tableCount=0,fieldCount=0,inheritedCount=0,wildcardCount=0;for(var ai=0;ai<out.applicableAcls.length;ai++){var a=out.applicableAcls[ai];if(a.name.indexOf('.')>=0)fieldCount++;else tableCount++;if(a.inherited)inheritedCount++;if(a.wildcard)wildcardCount++;}
	out.aclCoverage.operation=aclOp;out.aclCoverage.requestedOperation=requestedOp;out.aclCoverage.hierarchy=hierarchy;out.aclCoverage.tableAclCount=tableCount;out.aclCoverage.fieldAclCount=fieldCount;out.aclCoverage.inheritedAclCount=inheritedCount;out.aclCoverage.wildcardAclCount=wildcardCount;
	if(out.aclCoverage.metadataReadable){out.aclCoverage.coverage=out.applicableAcls.length?'present':'none';out.aclCoverage.diagnosis=out.applicableAcls.length?'Applicable ACL metadata exists; roles, conditions, scripts, and runtime identity may still deny access.':'No applicable table, field, inherited, or wildcard ACL was found for this operation; secure access defaults to deny.';}else{out.aclCoverage.coverage='unknown';out.aclCoverage.diagnosis='ACL metadata was not readable, so absence of ACL coverage cannot be established.';}
var d=new GlideRecord('sys_dictionary');d.addQuery('internal_type','reference');d.addQuery('reference',table);d.addNotNullQuery('element');d.setLimit(100);d.query();while(d.next()){var child=String(d.getValue('name')),field=String(d.getValue('element'));try{var dep=new GlideRecord(child);dep.addQuery(field,id);dep.setLimit(101);dep.query();var n=0;while(dep.next()&&n<101)n++;if(n>0)out.referenceDependencies.push({table:child,field:field,count:n,countCapped:n===101});}catch(e){}}
log(JSON.stringify(out));})();`;
				const r = await scriptService.executeBackgroundScript(script, 60000, v.instance);
				if (!r.success || !r.output)
					throw new Error(r.error || 'Diagnostic script returned no output');
				const parsed = JSON.parse(r.output.trim().split('\n').pop() || '{}');
				const response = {
					success: true,
					table: v.tableName,
					sysId: v.sysId,
					operation: v.operation,
					identity: parsed.identity || {},
					recordExists: !!parsed.recordExists,
					capabilities: parsed.capabilities || {},
					fieldCapabilities: parsed.fieldCapabilities || [],
					activeBusinessRules: parsed.activeBusinessRules || [],
					applicableAcls: parsed.applicableAcls || [],
					aclCoverage: parsed.aclCoverage || {
						metadataReadable: false,
						coverage: 'unknown',
						diagnosis: 'The diagnostic response did not include ACL coverage metadata.',
					},
					...(parsed.aclCoverage?.coverage === 'none'
						? { probableBlocker: 'missing_acl_coverage' }
						: parsed.aclCoverage?.coverage === 'unknown'
							? { probableBlocker: 'acl_coverage_unknown' }
							: {}),
					referenceDependencies: parsed.referenceDependencies || [],
					limitations: [
						`Evaluated as the background-script identity (${
							parsed.identity?.userName || 'unknown'
						}), NOT the REST user the write tools authenticate as — these verdicts can differ in both directions. For the API user's verdict use sn_get_security_info (effectiveAccess).`,
						'No mutation was attempted.',
						'ACL scripts and business-rule conditions were not individually evaluated.',
						'Reference discovery is capped at 100 dictionary fields and 101 rows per dependency.',
					],
				};
				return toolResult(response, `mutation diagnostics collected for ${v.tableName} ${v.sysId}`);
			} catch (error) {
				return toolError(error, {
					operation: 'diagnose mutation',
					requiredRoles: ['admin', 'security_admin'],
				});
			}
		},
	};
}
