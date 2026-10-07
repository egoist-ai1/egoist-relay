# Relay UI grouped-route triage

Independent read-only triage of original 2026-10-02T03:52:51.873Z evidence. No browser rerun, account/network/system action or product/harness edit. All125 cases retained; zero PASS promotions.

Original125 cases:33 PASS,92 gated,0 page errors. Primary classification: selector_or_route_mismatch=100, observed_body_partial=3, bad_requested_enum=5, fixture_data_missing=17. No recorded exception proves only no observed error in this synthetic run.

## Evidence rules

First nested active Transition can be Loading while meaningful settings controls exist, or RightHeader h3 while right body has no data. Text and controls currently use different scopes. Direct Settings target: #Settings > .Transition_slide-active. Direct Right body: #RightColumn > .Transition > .Transition_slide-active. Wait requested body, not enum/title.

Settings usually .settings-content; Main .settings-main-scroll; Management mostly .Management/.panel-content; Poll .PollResults.custom-scroll + .poll-question. Statistics require overview/chart/error body. DataStorage, Language and GroupPermissions show partial nonheader body evidence; other routes need corrected measurement/preconditions.

## Highest-value changes

- route-measurement: All125 cases need corrected measurement;100 primary selector/readiness mismatches. Direct body selector, settle requested route, same scope text/controls, actual import source mapping.
- folder-fixtures: 10 Folders* routes. Actual folder + route-specific reducer/filter/share panel entry.
- small-settings-topic-seeds: ActiveSessions,Passkeys,QuickReaction,CustomEmoji,EditTopic. Small honest empty/populated data branches.
- member-navigation: 3 rights routes plus Initial/GroupMembers readiness. Actual synthetic row clicks set local target; existing admin101 and separate nonadmin fixture; reset real Initial and wait body.
- stats-poll: 7 right data-dependent routes; optional after broad selector fix. Exact tab/global payload, overview/error/zero-voter evidence separate from full charts/paging.

## Exact contracts and boundaries

JSON safeSeeds contains actual ApiChatFolder,ApiSession,ApiPasskey,ApiAvailableReaction,ApiStickerSet,ApiTopic,ApiGroupStatistics,ApiMessagePoll shape/path/preconditions. Create folder resets reducer; edit requires actual byId entry; filters need temp state; Share needs selected panel. Saved-passkey row requires nonempty array. Member selection is local state and must use real synthetic row click.

AddByPhone/PhoneP2P are parent-screen subsections. GroupType offered control opens ChatPrivacyType. EventLog explicitly disabled. Right NewGroup is a left-column workflow. Error-graph fixtures prove overview/error branch only; zero-voter poll proves empty-voter body only. No protected form submission; no full-chart/media/server/paging claim.

## Per-case registry

| Case | Original | Primary cause | Visible controls |
|---|---|---|
| settings-route-Main | gated | selector_or_route_mismatch | absent |
| settings-route-EditProfile | gated | selector_or_route_mismatch | absent |
| settings-route-Notifications | gated | selector_or_route_mismatch | absent |
| settings-route-DataStorage | pass | observed_body_partial | 15 |
| settings-route-Language | pass | observed_body_partial | 4 |
| settings-route-ActiveSessions | gated | selector_or_route_mismatch | 5 |
| settings-route-General | gated | selector_or_route_mismatch | 16 |
| settings-route-GeneralChatBackground | gated | selector_or_route_mismatch | 6 |
| settings-route-GeneralChatBackgroundColor | gated | selector_or_route_mismatch | 3 |
| settings-route-Privacy | gated | selector_or_route_mismatch | 17 |
| settings-route-AutoDeleteMessages | gated | selector_or_route_mismatch | 6 |
| settings-route-PrivacyPhoneNumber | gated | selector_or_route_mismatch | 6 |
| settings-route-PrivacyAddByPhone | gated | bad_requested_enum | 3 |
| settings-route-PrivacyLastSeen | gated | selector_or_route_mismatch | 8 |
| settings-route-PrivacyProfilePhoto | gated | selector_or_route_mismatch | 7 |
| settings-route-PrivacyBio | gated | selector_or_route_mismatch | 6 |
| settings-route-PrivacyBirthday | gated | selector_or_route_mismatch | 6 |
| settings-route-PrivacyGifts | gated | selector_or_route_mismatch | 16 |
| settings-route-PrivacyPhoneCall | gated | selector_or_route_mismatch | 11 |
| settings-route-PrivacyPhoneP2P | gated | bad_requested_enum | 3 |
| settings-route-PrivacyForwarding | gated | selector_or_route_mismatch | 6 |
| settings-route-PrivacyVoiceMessages | gated | selector_or_route_mismatch | 5 |
| settings-route-PrivacyMessages | gated | selector_or_route_mismatch | 5 |
| settings-route-PrivacyGroupChats | gated | selector_or_route_mismatch | 6 |
| settings-route-PrivacyPhoneNumberAllowedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyPhoneNumberDeniedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyLastSeenAllowedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyLastSeenDeniedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyProfilePhotoAllowedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyProfilePhotoDeniedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyBioAllowedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyBioDeniedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyBirthdayAllowedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyBirthdayDeniedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyGiftsAllowedContacts | gated | selector_or_route_mismatch | 5 |
| settings-route-PrivacyGiftsDeniedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyPhoneCallAllowedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyPhoneCallDeniedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyPhoneP2PAllowedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyPhoneP2PDeniedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyForwardingAllowedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyForwardingDeniedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyVoiceMessagesAllowedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyVoiceMessagesDeniedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyGroupChatsAllowedContacts | gated | selector_or_route_mismatch | 5 |
| settings-route-PrivacyGroupChatsDeniedContacts | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyBlockedUsers | gated | selector_or_route_mismatch | 2 |
| settings-route-PrivacyNoPaidMessages | gated | selector_or_route_mismatch | 2 |
| settings-route-Performance | gated | selector_or_route_mismatch | 5 |
| settings-route-Folders | gated | selector_or_route_mismatch | 5 |
| settings-route-FoldersCreateFolder | gated | fixture_data_missing | 18 |
| settings-route-FoldersEditFolder | gated | fixture_data_missing | 5 |
| settings-route-FoldersEditFolderFromChatList | gated | fixture_data_missing | 27 |
| settings-route-FoldersEditFolderInvites | gated | fixture_data_missing | 25 |
| settings-route-FoldersIncludedChats | gated | selector_or_route_mismatch | 23 |
| settings-route-FoldersIncludedChatsFromChatList | gated | selector_or_route_mismatch | 23 |
| settings-route-FoldersExcludedChats | gated | selector_or_route_mismatch | 17 |
| settings-route-FoldersExcludedChatsFromChatList | gated | selector_or_route_mismatch | 17 |
| settings-route-TwoFaDisabled | gated | selector_or_route_mismatch | 2 |
| settings-route-TwoFaNewPassword | gated | selector_or_route_mismatch | 4 |
| settings-route-TwoFaNewPasswordConfirm | gated | selector_or_route_mismatch | 4 |
| settings-route-TwoFaNewPasswordHint | gated | selector_or_route_mismatch | 3 |
| settings-route-TwoFaNewPasswordEmail | gated | selector_or_route_mismatch | 3 |
| settings-route-TwoFaNewPasswordEmailCode | gated | selector_or_route_mismatch | 2 |
| settings-route-TwoFaEnabled | gated | selector_or_route_mismatch | 4 |
| settings-route-TwoFaChangePasswordCurrent | gated | selector_or_route_mismatch | 4 |
| settings-route-TwoFaChangePasswordNew | gated | selector_or_route_mismatch | 4 |
| settings-route-TwoFaChangePasswordConfirm | gated | selector_or_route_mismatch | 4 |
| settings-route-TwoFaChangePasswordHint | gated | selector_or_route_mismatch | 3 |
| settings-route-TwoFaTurnOff | gated | selector_or_route_mismatch | 4 |
| settings-route-TwoFaRecoveryEmailCurrentPassword | gated | selector_or_route_mismatch | 4 |
| settings-route-TwoFaRecoveryEmail | gated | selector_or_route_mismatch | 3 |
| settings-route-TwoFaRecoveryEmailCode | gated | selector_or_route_mismatch | 2 |
| settings-route-TwoFaCongratulations | gated | selector_or_route_mismatch | 2 |
| settings-route-ActiveWebsites | gated | selector_or_route_mismatch | 4 |
| settings-route-PasscodeDisabled | gated | selector_or_route_mismatch | 2 |
| settings-route-PasscodeNewPasscode | gated | selector_or_route_mismatch | 5 |
| settings-route-PasscodeNewPasscodeConfirm | gated | selector_or_route_mismatch | 5 |
| settings-route-PasscodeEnabled | gated | selector_or_route_mismatch | 3 |
| settings-route-PasscodeChangePasscodeCurrent | gated | selector_or_route_mismatch | 5 |
| settings-route-PasscodeChangePasscodeNew | gated | selector_or_route_mismatch | 5 |
| settings-route-PasscodeChangePasscodeConfirm | gated | selector_or_route_mismatch | 5 |
| settings-route-PasscodeTurnOff | gated | selector_or_route_mismatch | 5 |
| settings-route-PasscodeCongratulations | gated | selector_or_route_mismatch | 2 |
| settings-route-Experimental | gated | selector_or_route_mismatch | 10 |
| settings-route-Stickers | gated | selector_or_route_mismatch | 4 |
| settings-route-QuickReaction | gated | fixture_data_missing | 1 |
| settings-route-CustomEmoji | gated | fixture_data_missing | 1 |
| settings-route-DoNotTranslate | gated | selector_or_route_mismatch | 34 |
| settings-route-FoldersShare | gated | fixture_data_missing | 4 |
| settings-route-Passkeys | gated | selector_or_route_mismatch | 2 |
| management-route-Initial | pass | selector_or_route_mismatch | 14 |
| management-route-ChatPrivacyType | pass | selector_or_route_mismatch | 9 |
| management-route-Discussion | pass | selector_or_route_mismatch | 2 |
| management-route-ChannelSubscribers | pass | selector_or_route_mismatch | 5 |
| management-route-GroupType | gated | bad_requested_enum | 5 |
| management-route-GroupPermissions | pass | observed_body_partial | 20 |
| management-route-GroupRemovedUsers | pass | selector_or_route_mismatch | 2 |
| management-route-ChannelRemovedUsers | pass | selector_or_route_mismatch | 2 |
| management-route-GroupUserPermissionsCreate | pass | selector_or_route_mismatch | 2 |
| management-route-GroupUserPermissions | pass | fixture_data_missing | 2 |
| management-route-ChatAdministrators | pass | selector_or_route_mismatch | 4 |
| management-route-GroupRecentActions | gated | bad_requested_enum | 4 |
| management-route-ChatAdminRights | pass | fixture_data_missing | 1 |
| management-route-ChatNewAdminRights | pass | fixture_data_missing | 1 |
| management-route-GroupMembers | pass | selector_or_route_mismatch | 1 |
| management-route-GroupAddAdmins | pass | selector_or_route_mismatch | 5 |
| management-route-Invites | pass | selector_or_route_mismatch | 4 |
| management-route-EditInvite | pass | selector_or_route_mismatch | 14 |
| management-route-Reactions | pass | selector_or_route_mismatch | 4 |
| management-route-InviteInfo | pass | selector_or_route_mismatch | 6 |
| management-route-JoinRequests | pass | selector_or_route_mismatch | 1 |
| management-route-NewDiscussionGroup | pass | selector_or_route_mismatch | 4 |
| right-route-ChatInfo | pass | selector_or_route_mismatch | 8 |
| right-route-Management | pass | selector_or_route_mismatch | 4 |
| right-route-Statistics | pass | fixture_data_missing | 1 |
| right-route-BoostStatistics | pass | fixture_data_missing | 1 |
| right-route-MessageStatistics | pass | fixture_data_missing | 1 |
| right-route-StoryStatistics | pass | fixture_data_missing | 1 |
| right-route-PollResults | pass | fixture_data_missing | 1 |
| right-route-AddingMembers | pass | selector_or_route_mismatch | 2 |
| right-route-CreateTopic | pass | selector_or_route_mismatch | 2 |
| right-route-EditTopic | pass | fixture_data_missing | 2 |
| right-route-MonetizationStatistics | pass | fixture_data_missing | 1 |
| right-route-NewGroup | gated | bad_requested_enum | 0 |

## Review snapshot

Authoritative ui-gate-triage.json has3 neutral reviewObjects for root companion board. Source/input hashes recorded; active UI-agent fixes require final frozen-source rerun.

## Corrected-run diagnostic appendix

Version2 adds diagnostics from main 2026-10-02T04:46:36.739Z and grouped 2026-10-02T04:31:12.487Z; original125-case registry/classification above is unchanged. Corrected grouped summary: {"total":125,"pass":108,"gated":17,"errors":4}. Main summary: {"total":2,"pass":1,"fail":1,"gated":0,"sourceComponents":774,"renderedEvidenceComponents":2}.

Two bootstrap undefined.map messages follow an invalid mock folder title contract. relay-ui.json uses string; createMockedDialogFilter passes it into current DialogFilter.title:TextWithEntities; fetchChatFolders → buildApiChatFolder → buildApiFormattedText calls entities.map. Both FoldersSidebar and ChatFolders load folders. Exact source-extracted formatter throws the recorded error for the string, and succeeds for {text:string,entities:[]}. Original logs discarded stack, so a clean final run must establish that both occurrences are removed.

CustomEmojiPicker withDefaultTopicIcons requires BOTH global.defaultTopicIconsId and matching global.stickers.setsById entry before topic route mount. Minimal numeric-string id900000001 ApiStickerSet has accessHash0,title,shortName,count0,isEmoji:true,stickers:[]. Exact extracted production branch throws for absent pack and succeeds for empty typed pack. Added custom emoji ids alone do not initialize this default pack. Typed GetStickerSet RPC response also requires set,packs,keywords,documents; inner set requires BigInt id/accessHash and hash0.

Current unsupported MockClient fallback is undefined; no current universal {} default found. Worker buildApiError/handlers strip stacks and audit String(reason) produces [object Object]. Retain global bootstrap errors as completion gates; add stack/request provenance in owned harness diagnostics if needed. No production code, harness, account, network or running browser changed by this triage.

The JSON diagnosticAppendices records both input hashes, exact source hashes, actual-source extraction results, minimal typed seeds and final required checks. New neutral review object: ui-triage-contract-errors.
