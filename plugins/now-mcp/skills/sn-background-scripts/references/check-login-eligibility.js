/**
 * Template: check-login-eligibility
 * Purpose: Diagnose why a ServiceNow user account can't authenticate via
 *          now-mcp's basic auth — checks every account-state precondition in
 *          one read-only call instead of several manual sys_user lookups.
 * Scope:   READ-ONLY, safe on any instance including prod — performs zero
 *          writes.
 * Run via: sn_execute_background_script with resultMode: 'json'
 *          (no allowWrites needed).
 * Limitations: the role check only sees roles assigned DIRECTLY to the user
 *          on sys_user_has_role — a role inherited through group membership
 *          won't show up here. The MFA check reads the instance-wide
 *          glide.authenticate.multifactor property only; a per-role or
 *          per-group MFA policy (sys_mfa_policy_context, see disable-mfa.js)
 *          can still block login even when this reports MFA as off.
 *
 * Before running: replace {{USERNAME}} below with the account's user_name.
 */
(function () {
	var USERNAME = '{{USERNAME}}';
	var out = { success: true, username: USERNAME };

	var u = new GlideRecord('sys_user');
	if (!u.get('user_name', USERNAME)) {
		log(JSON.stringify({ success: false, error: 'user not found: ' + USERNAME }));
		return;
	}

	out.active = u.getValue('active') === 'true';
	out.lockedOut = u.getValue('locked_out') === 'true';
	out.hasLocalPassword = !!u.getValue('user_password');
	out.passwordNeedsReset = u.getValue('password_needs_reset') === 'true';
	out.webServiceAccessOnly = u.getValue('web_service_access_only') === 'true';

	try {
		var roleCheck = new GlideRecord('sys_user_has_role');
		roleCheck.addQuery('user', u.getUniqueValue());
		roleCheck.addQuery('role.name', 'snc_basic_auth_api_access');
		roleCheck.setLimit(1);
		roleCheck.query();
		out.hasBasicAuthApiAccessRole = roleCheck.hasNext();
	} catch (roleError) {
		out.hasBasicAuthApiAccessRoleError = String(roleError);
	}

	try {
		out.mfaEnforcedInstanceWide = gs.getProperty('glide.authenticate.multifactor') === 'true';
	} catch (mfaError) {
		out.mfaEnforcedInstanceWideError = String(mfaError);
	}

	var blockers = [];
	if (!out.active) blockers.push('user is not Active');
	if (out.lockedOut) blockers.push('user is Locked out');
	if (!out.hasLocalPassword) blockers.push('no local password set (SSO-only account?)');
	if (out.passwordNeedsReset)
		blockers.push(
			'Password needs reset is true — an admin-set password is rejected for API auth ' +
				'until the user logs in interactively and changes it themselves',
		);
	if (!out.webServiceAccessOnly && !out.hasBasicAuthApiAccessRole)
		blockers.push('neither Web service access only nor the snc_basic_auth_api_access role is set');
	if (out.mfaEnforcedInstanceWide)
		blockers.push(
			'MFA is enforced instance-wide (glide.authenticate.multifactor) — basic/OAuth ' +
				'password grant cannot satisfy an interactive MFA challenge',
		);
	out.blockers = blockers;
	out.eligible = blockers.length === 0;

	out.generatedAt = new GlideDateTime().getValue() + ' UTC';
	log(JSON.stringify(out));
})();
