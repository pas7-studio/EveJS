"use strict";
// In pinned V23.02, GetAllVisibleCampaigns replies with a fixed, time-expired
// VISIBLE_CAMPAIGN_SNAPSHOTS array. No authentic persistent campaign authority
// backs it; do not assert those static entries are currently live.
function getAuthoritativeVisibleCampaigns() {
  return []; // NOT evidence of zero campaigns in EVE Online or in any newer server.
}
module.exports={getAuthoritativeVisibleCampaigns};
