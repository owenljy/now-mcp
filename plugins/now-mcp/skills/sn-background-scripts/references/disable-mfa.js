/**
 * Template: disable-mfa
 * Purpose: Turn off MFA enforcement on a non-prod ServiceNow instance so
 *          now-mcp's Basic/OAuth password-grant auth can authenticate
 *          (neither grant can satisfy an interactive MFA challenge).
 * Scope:   NON-PROD ONLY. Never run against a production instance — this
 *          globally disables multifactor authentication for all users.
 * Run via: sn_execute_background_script with allowWrites: true and
 *          allowMetadataWrites: true (it writes sys_properties and
 *          deactivates a sys_authentication_policy record).
 * Reversal: re-enable via System Properties
 *          (glide.authenticate.multifactor -> true) and reactivate the
 *          deactivated sys_authentication_policy record logged below.
 */
disableMFA();

function disableMFA() {
	disableMFAContextPolicy();
	GlidePropertiesDB.set('glide.authenticate.multifactor.disable.reason', 'non_prod_mfa_not_needed');
	GlidePropertiesDB.set('glide.authenticate.multifactor', false);
}

function disableMFAContextPolicy() {
	var gr = new GlideRecord('sys_mfa_policy_context');
	if (!gr.isValid()) {
		gs.log('sys_mfa_policy_context does not exist');
		return;
	}
	gr.addEncodedQuery(
		'default_policy=stepup_mfa_policy^stepup_mfa_policy.active=true^NQdefault_policy=stepdown_mfa_policy^stepdown_mfa_policy.active=true',
	);
	gr.query();
	if (gr.next()) {
		var default_policy = gr.getValue('default_policy');
		if (default_policy != 'stepup_mfa_policy' && default_policy != 'stepdown_mfa_policy') {
			gs.log(default_policy);
			gs.log('invalid default MFA Context policy');
			return;
		}
		var policyId = gr.getValue(default_policy);
		var policyGr = new GlideRecord('sys_authentication_policy');
		if (!policyGr.isValid()) {
			gs.log('sys_authentication_policy does not exist');
			return;
		}
		if (policyGr.get(policyId)) {
			policyGr.setValue('active', false);
			policyGr.update();
			gs.log('Policy deactivated - PolicyID : ' + policyId);
		}
		gs.log('Default MFA Context Policy is disabled');
	}
}
