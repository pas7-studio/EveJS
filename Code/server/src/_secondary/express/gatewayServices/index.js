const { createCompatibilityGatewayService } = require("./compatibilityGatewayService");
const { createCorpGoalsGatewayService } = require("./corpGoalsGatewayService");
const { createCorpColorsGatewayService } = require("./corpColorsGatewayService");
const { createEvermarksGatewayService } = require("./evermarksGatewayService");
const { createFreelanceGatewayService } = require("./freelanceGatewayService");
const {
  createFwAdvantageGatewayService,
} = require("./fwAdvantageGatewayService");
const {
  createGoalContributionGatewayService,
} = require("./goalContributionGatewayService");
const {
  createDailyGoalGatewayService,
} = require("./dailyGoalGatewayService");
const {
  createAbsentStateGatewayService,
} = require("./absentStateGatewayService");
const {
  createCareerGatewayService,
} = require("./careerGatewayService");
const {
  createEntityLookupGatewayService,
} = require("./entityLookupGatewayService");
const {
  createStargateLockGatewayService,
} = require("./stargateLockGatewayService");
const {
  createThirdPartySkinGatewayService,
} = require("./thirdPartySkinGatewayService");
const {
  createThirdPartySkinDraftGatewayService,
} = require("./thirdPartySkinDraftGatewayService");
const { createInsurgencyGatewayService } = require("./insurgencyGatewayService");
const {
  createMercenaryDenGatewayService,
} = require("./mercenaryDenGatewayService");
const {
  createLocalChatGatewayService,
} = require("./localChatGatewayService");
const {
  createNewEdenStoreGatewayService,
} = require("./newEdenStoreGatewayService");
const { createPlexVaultGatewayService } = require("./plexVaultGatewayService");
const {
  createPresenceGatewayService,
} = require("./presenceGatewayService");
const {
  createSovereigntyGatewayService,
} = require("./sovereigntyGatewayService");
const {
  createStructurePaintworkGatewayService,
} = require("./structurePaintworkGatewayService");
const {
  createShipLogoGatewayService,
} = require("./shipLogoGatewayService");
const {
  createSkillPlanGatewayService,
} = require("./skillPlanGatewayService");
const {
  createCorpSkillPlanGatewayService,
} = require("./corpSkillPlanGatewayService");
const {
  createMapTagsGatewayService,
} = require("./mapTagsGatewayService");
const {
  createCampaignGatewayService,
} = require("./campaignGatewayService");

function createGatewayServiceRegistry(context) {
  const services = [
    createCorpGoalsGatewayService(context),
    createCorpColorsGatewayService(context),
    createEvermarksGatewayService(context),
    createFreelanceGatewayService(context),
    createFwAdvantageGatewayService(context),
    createGoalContributionGatewayService(context),
    createDailyGoalGatewayService(context),
    createEntityLookupGatewayService(context),
    createCareerGatewayService(context),
    createAbsentStateGatewayService(context),
    createStargateLockGatewayService(context),
    createThirdPartySkinGatewayService(context),
    createThirdPartySkinDraftGatewayService(context),
    createInsurgencyGatewayService(context),
    createNewEdenStoreGatewayService(context),
    createPlexVaultGatewayService(context),
    createPresenceGatewayService(context),
    createStructurePaintworkGatewayService(context),
    createShipLogoGatewayService(context),
    createSovereigntyGatewayService(context),
    createMercenaryDenGatewayService(context),
    createLocalChatGatewayService(context),
    createSkillPlanGatewayService(context),
    createCorpSkillPlanGatewayService(context),
    createMapTagsGatewayService(context),
    createCampaignGatewayService(context),
    createCompatibilityGatewayService(context),
  ];

  return {
    services,
    getEmptySuccessResponseType(requestTypeName) {
      for (const service of services) {
        if (typeof service.getEmptySuccessResponseType !== "function") {
          continue;
        }

        const responseTypeName = service.getEmptySuccessResponseType(
          requestTypeName,
        );
        if (responseTypeName) {
          return responseTypeName;
        }
      }

      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      for (const service of services) {
        const result = service.handleRequest(requestTypeName, requestEnvelope);
        if (result) {
          return result;
        }
      }

      return null;
    },
  };
}

module.exports = {
  createGatewayServiceRegistry,
};
