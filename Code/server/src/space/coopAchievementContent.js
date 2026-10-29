"use strict";
// Our own achievement catalogue: the definitions file the client downloads.
//
// In New Eden this is CCP content; here it is ours, because the server is ours. The client asks
// the gateway for the latest checkpoint (url + version + crc), downloads the buffer, verifies the
// CRC and parses a flatbuffer whose root is `AchievementData`. The repository that reads it walks
// exactly two roots - `Challenges()` and `TimeLimited()` - and one vector of contribution methods,
// so all three must be present: a missing root is `None` there and breaks the whole page.
//
//   AchievementData { Challenges: Category, TimeLimited: Category,
//                     ContributionMethods: [ContributionMethodDefinition] }
//   Category        { Id: uuid text, Name/Description: message ids, Achievements: [Achievement] }
//   Achievement     { Id: uuid text, Name/Description/FlavorText: message ids, Contribution:
//                     ContributionConfig, Milestones: [AchievementMilestone] }
//   AchievementMilestone { Id: uuid text, Target: uint32, CategoryPoints: uint32,
//                          Rewards: [Reward] }
//   Reward          { Id: uuid text, PayloadType: union tag, Payload: SpReward }
//
// Names are localization message ids, not text: the client resolves them through its own message
// table, so every id below is a real id from that table (the comment quotes the string it shows).
// Inventing ids would render as "[unresolved]" in game, which is why they were read from the
// client's localization data once and written down here.
//
// A reward is skill points, and it is really paid: claim calls space/coopSkillPointGrant with the
// amount declared here (see space/coopAchievements). Nothing in this file mints ISK.
const zlib = require("zlib");
const { FlatbufferBuilder } = require("./coopFlatbuffer");

const CDN_PATH = "/elysian-eve/achievements/1.0.0.achievements";
const FILE_IDENTIFIER = "ACHV";
const VERSION = Object.freeze({ major: 1, minor: 0, patch: 0 });
const ROOT_FIELD_COUNT = 4;
const CATEGORY_FIELD_COUNT = 9;
const ACHIEVEMENT_FIELD_COUNT = 14;
const MILESTONE_FIELD_COUNT = 5;
const REWARD_FIELD_COUNT = 4;
const METHOD_FIELD_COUNT = 10;
const PROGRESS_UNION_CUMULATIVE = 1;
const REWARD_UNION_SP = 2;

// The one contribution method the catalogue uses: cumulative progress towards a target.
const METHODS = Object.freeze([
  {
    id: "coop_cumulative",
    nameId: 596213, // "Progress"
    descriptionId: 583902, // "Milestones"
    progressDescriptionId: 596213, // "Progress"
    progressType: PROGRESS_UNION_CUMULATIVE,
  },
]);

// Two root categories, because the client loads both unconditionally.
const CATEGORIES = Object.freeze([
  {
    id: "4a1b2c3d4e5f60718293a4b5c6d7e801",
    nameId: 526698, // "Operations"
    descriptionId: 1035913, // "Achievements"
    iconId: "",
    internalName: "coop_operations",
    achievements: [
      {
        id: "5b2c3d4e5f60718293a4b5c6d7e8f902",
        nameId: 529378, // "Mining"
        descriptionId: 61405, // "Mine minerals from asteroid belts/clouds."
        iconId: "",
        internalName: "coop_mine_ore",
        contributionMethodId: "coop_cumulative",
        milestones: [
          {
            id: "6c3d4e5f60718293a4b5c6d7e8f90112",
            target: 1,
            categoryPoints: 10,
            internalName: "coop_mine_ore_first",
            skillPoints: 1000,
          },
          {
            id: "7d4e5f60718293a4b5c6d7e8f9011223",
            target: 100,
            categoryPoints: 25,
            internalName: "coop_mine_ore_hundred",
            skillPoints: 2500,
          },
        ],
      },
      {
        id: "8e5f60718293a4b5c6d7e8f901122334",
        nameId: 63600, // "Hauler"
        descriptionId: 54861, // "Cargo Transportation"
        iconId: "",
        internalName: "coop_haul_cargo",
        contributionMethodId: "coop_cumulative",
        milestones: [
          {
            id: "9f60718293a4b5c6d7e8f90112233445",
            target: 1,
            categoryPoints: 10,
            internalName: "coop_haul_cargo_first",
            skillPoints: 1500,
          },
        ],
      },
      {
        id: "a0718293a4b5c6d7e8f9011223344556",
        nameId: 529377, // "Combat"
        descriptionId: 58359, // "Combat Basics"
        iconId: "",
        internalName: "coop_win_fight",
        contributionMethodId: "coop_cumulative",
        milestones: [
          {
            id: "b18293a4b5c6d7e8f901122334455667",
            target: 1,
            categoryPoints: 10,
            internalName: "coop_win_fight_first",
            skillPoints: 2000,
          },
        ],
      },
    ],
  },
  {
    id: "c293a4b5c6d7e8f90112233445566778",
    nameId: 1037682, // "Time Limited"
    descriptionId: 583902, // "Milestones"
    iconId: "",
    internalName: "coop_time_limited",
    achievements: [],
  },
]);

const DETAILS = Object.freeze({
  cdnPath: CDN_PATH,
  version: VERSION,
  categories: CATEGORIES,
  methods: METHODS,
});

function contentOrigin(env = process.env) {
  const configured = String(env.EVEJS_COOP_CONTENT_ORIGIN || "").trim().replace(/\/+$/, "");
  return configured || "https://127.0.0.1";
}

function crc32(buffer) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buffer) >>> 0;
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      }
      table[index] = value;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function buildAchievementData(details = DETAILS) {
  const builder = new FlatbufferBuilder(16384);
  const vector = (offsets) => builder.createVectorOfOffsets(offsets);
  const string = (value) => builder.createString(String(value == null ? "" : value));

  const milestonesFor = (achievement) => achievement.milestones.map((milestone) => {
    const id = string(milestone.id);
    const internalName = string(milestone.internalName);
    const rewardId = string(`${milestone.id.slice(0, 28)}c0de`);
    const rewardName = string(`${milestone.internalName}_sp`);
    const payload = (() => {
      builder.startTable(1);
      builder.scalarSlot(0, milestone.skillPoints, "uint64");
      return builder.endTable();
    })();
    builder.startTable(REWARD_FIELD_COUNT);
    builder.slot(0, rewardId);
    builder.scalarSlot(1, REWARD_UNION_SP, "uint8");
    builder.slot(2, payload);
    builder.slot(3, rewardName);
    const reward = builder.endTable();

    builder.startTable(MILESTONE_FIELD_COUNT);
    builder.slot(0, id);
    // Target is uint64 in the client's generated reader (SpReward.Quantity is uint64 too); writing
    // it as uint32 makes the client decode the neighbouring bytes into the number.
    builder.scalarSlot(1, milestone.target, "uint64");
    builder.scalarSlot(2, milestone.categoryPoints);
    builder.slot(3, vector([reward]));
    builder.slot(4, internalName);
    return builder.endTable();
  });

  const achievementsFor = (category) => category.achievements.map((achievement) => {
    const id = string(achievement.id);
    const icon = string(achievement.iconId);
    const internalName = string(achievement.internalName);
    const contribution = (() => {
      const methodId = string(achievement.contributionMethodId);
      builder.startTable(2);
      builder.slot(0, methodId);
      builder.slot(1, vector([]));
      return builder.endTable();
    })();
    const milestones = vector(milestonesFor(achievement));

    builder.startTable(ACHIEVEMENT_FIELD_COUNT);
    builder.slot(0, id);
    builder.scalarSlot(1, achievement.nameId);
    builder.scalarSlot(2, achievement.descriptionId);
    builder.slot(4, icon);
    builder.slot(6, contribution);
    builder.slot(7, milestones);
    builder.slot(13, internalName);
    return builder.endTable();
  });

  const categoryFor = (category) => {
    const id = string(category.id);
    const icon = string(category.iconId);
    const internalName = string(category.internalName);
    const achievements = vector(achievementsFor(category));
    builder.startTable(CATEGORY_FIELD_COUNT);
    builder.slot(0, id);
    builder.scalarSlot(1, category.nameId);
    builder.scalarSlot(2, category.descriptionId);
    builder.slot(3, icon);
    builder.slot(6, achievements);
    builder.slot(7, internalName);
    return builder.endTable();
  };

  const methods = details.methods.map((method) => {
    const id = string(method.id);
    const progress = (() => {
      builder.startTable(0);
      return builder.endTable();
    })();
    builder.startTable(METHOD_FIELD_COUNT);
    builder.slot(0, id);
    builder.scalarSlot(1, method.nameId);
    builder.scalarSlot(2, method.descriptionId);
    builder.scalarSlot(5, method.progressDescriptionId);
    builder.slot(6, vector([]));
    builder.scalarSlot(7, method.progressType, "uint8");
    builder.slot(8, progress);
    builder.slot(9, vector([]));
    return builder.endTable();
  });

  const challenges = categoryFor(details.categories[0]);
  const timeLimited = categoryFor(details.categories[1]);

  builder.startTable(ROOT_FIELD_COUNT);
  builder.slot(1, challenges);
  builder.slot(2, timeLimited);
  builder.slot(3, vector(methods));
  const root = builder.endTable();
  return Buffer.from(builder.finish(root, FILE_IDENTIFIER));
}

function achievements() {
  return CATEGORIES.flatMap((category) => category.achievements.map((achievement) => ({
    ...achievement,
    categoryId: category.id,
  })));
}

// The declared skill points for one achievement: its milestones are the steps of the same
// achievement, and completion means every target was met, so a claim pays them all once.
function skillPointsFor(achievementID) {
  const key = String(achievementID == null ? "" : achievementID).trim().toLowerCase();
  const achievement = achievements().find((entry) => entry.id === key);
  if (!achievement) return 0;
  return achievement.milestones.reduce((total, milestone) => total + milestone.skillPoints, 0);
}

let cached = null;

// One frozen object, so the advertised url, version and CRC always describe the same bytes.
function content() {
  if (!cached) {
    const buffer = buildAchievementData();
    cached = Object.freeze({
      buffer,
      crc: crc32(buffer),
      version: VERSION,
      path: CDN_PATH,
      url: `${contentOrigin()}${CDN_PATH}`,
    });
  }
  return cached;
}

// The loopback content host asks for a route; anything else is not ours.
function getAchievementContentAsset(routePath) {
  if (String(routePath || "") !== CDN_PATH) return null;
  return { buffer: content().buffer, contentType: "application/octet-stream" };
}

module.exports = {
  ACHIEVEMENT_FIELD_COUNT,
  CATEGORIES,
  CDN_PATH,
  FILE_IDENTIFIER,
  METHODS,
  VERSION,
  achievements,
  buildAchievementData,
  content,
  crc32,
  getAchievementContentAsset,
  skillPointsFor,
};
