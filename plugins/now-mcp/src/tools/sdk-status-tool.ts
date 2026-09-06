/**
 * MCP tool: report Fluent SDK (now-sdk) status and instance alignment.
 *
 * Only registered when now-sdk is on PATH. Surfaces the CLI version and its
 * auth profiles, and checks whether the MCP's configured instance(s) line up
 * with a now-sdk profile — so you don't deploy with Fluent to one instance
 * while querying another through the MCP.
 */

import { z } from 'zod';
import type { InstanceManager } from '../client/instance-manager.js';
import { SdkStatusOutputSchema } from '../schemas/output-schemas.js';
import { formatErrorForTool } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import {
	computeAlignment,
	deriveDefaultAlignment,
	getNowSdkVersion,
	isAuthListFormatVerified,
	isNowSdkAvailable,
	listNowSdkProfiles,
	NOW_SDK_FEATURE_CONSTRAINTS,
	parseSemVer,
	pickDefaultProfile,
	resolveFeatures,
} from '../utils/now-sdk-cli.js';
import { toolResult } from '../utils/tool-response.js';

export const SDK_STATUS_TOOL = {
	name: 'sn_sdk_status',
	title: 'now-sdk status',
	description: `What: Report the ServiceNow Fluent SDK (now-sdk) CLI version and auth profiles, and check that the MCP's configured instance(s) match a now-sdk profile.
When to use: Before/after Fluent deploys, to confirm now-sdk and the MCP point at the same instance (avoids "deployed to dev, queried prod").
Preconditions: now-sdk installed on PATH (this tool only appears when it is). No credentials are read or exposed — only hosts/aliases.
Produces: now-sdk version (+ parsed semver and a capability/feature map resolved for it), auth profiles (alias/host/type/default), and per-instance alignment.`,
	inputSchema: z.object({}),
	outputSchema: SdkStatusOutputSchema,
};

export function createSdkStatusTool(instanceManager: InstanceManager) {
	return {
		...SDK_STATUS_TOOL,
		handler: async () => {
			try {
				const [version, profiles] = await Promise.all([getNowSdkVersion(), listNowSdkProfiles()]);
				const semver = parseSemVer(version);
				const features = resolveFeatures(semver);

				const configured = instanceManager.listInstances().map((name) => ({
					name,
					url: instanceManager.getConfig(name).url,
				}));
				const alignment = computeAlignment(configured, profiles);

				const unaligned = alignment.filter((a) => !a.aligned).map((a) => a.instance);

				// Does the MCP DEFAULT instance match the instance now-sdk is connected
				// to? This is what drives the session-start "should we switch?" prompt.
				// Reuse the `profiles` already fetched above rather than spawning
				// `now-sdk auth --list` a second time via getDefaultAlignment().
				const defaultAlignment = deriveDefaultAlignment(
					pickDefaultProfile(profiles),
					configured,
					instanceManager.getDefaultInstance(),
					isNowSdkAvailable(),
				);

				const defaultNote =
					!defaultAlignment.defaultAligned && defaultAlignment.recommendedDefaultInstance
						? `MCP default instance '${defaultAlignment.mcpDefaultInstance}' does NOT match now-sdk's connected instance ` +
							`(profile '${defaultAlignment.nowSdkDefaultProfile}' → '${defaultAlignment.recommendedDefaultInstance}' at ${defaultAlignment.nowSdkDefaultHost}). ` +
							`To realign: remove SERVICENOW_FOLLOW_NOW_SDK=false (follow auto-aligns), or set default:true on '${defaultAlignment.recommendedDefaultInstance}' in the config YAML, or just pass instance:'${defaultAlignment.recommendedDefaultInstance}' explicitly on each call.`
						: 'MCP default instance is aligned with now-sdk (or no switch is warranted).';

				const response = {
					success: true,
					nowSdkVersion: version,
					nowSdkSemver: semver,
					// Capability map resolved for the detected version, plus the
					// constraints it was resolved from (so the agent/skill can see WHY a
					// feature is on/off without re-deriving the version math).
					features,
					featureConstraints: NOW_SDK_FEATURE_CONSTRAINTS,
					authListFormatVerified: isAuthListFormatVerified(semver),
					profiles,
					alignment,
					// Default-instance alignment (used by the session-start protocol).
					nowSdkDefaultProfile: defaultAlignment.nowSdkDefaultProfile,
					nowSdkDefaultHost: defaultAlignment.nowSdkDefaultHost,
					mcpDefaultInstance: defaultAlignment.mcpDefaultInstance,
					defaultAligned: defaultAlignment.defaultAligned,
					recommendedDefaultInstance: defaultAlignment.recommendedDefaultInstance,
					defaultNote,
					note:
						unaligned.length > 0
							? `These MCP instance(s) have no matching now-sdk auth profile: ${unaligned.join(', ')}. ` +
								`Add one with: now-sdk auth --add <url> --type basic --alias <name>.`
							: 'All configured MCP instances match a now-sdk auth profile.',
				};

				return toolResult(
					response,
					`now-sdk ${version}${unaligned.length > 0 ? ` — ${unaligned.length} instance(s) unaligned` : ''}`,
				);
			} catch (error) {
				logger.error('Error getting now-sdk status', error);
				return {
					content: [{ type: 'text' as const, text: formatErrorForTool(error) }],
					isError: true as const,
				};
			}
		},
	};
}
