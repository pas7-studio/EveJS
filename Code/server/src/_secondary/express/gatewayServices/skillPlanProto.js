const protobuf = require("protobufjs");

function buildSkillPlanProtoRoot() {
  return protobuf.Root.fromJSON({
    nested: {
      eve_public: {
        nested: {
          inventory: {
            nested: {
              genericitemtype: {
                nested: {
                  Identifier: {
                    fields: {
                      sequential: { type: "uint32", id: 1 },
                    },
                  },
                },
              },
            },
          },
          skilltype: {
            nested: {
              Identifier: {
                fields: {
                  sequential: { type: "uint32", id: 1 },
                },
              },
            },
          },
          skill: {
            nested: {
              plan: {
                nested: {
                  Identifier: {
                    fields: {
                      uuid: { type: "bytes", id: 1 },
                    },
                  },
                  Attributes: {
                    fields: {
                      name: { type: "string", id: 1 },
                      skill_requirements: {
                        rule: "repeated",
                        type: "eve_public.skill.plan.SkillRequirement",
                        id: 2,
                      },
                      description: { type: "string", id: 3 },
                    },
                  },
                  SkillRequirement: {
                    fields: {
                      skill_type: {
                        type: "eve_public.skilltype.Identifier",
                        id: 1,
                      },
                      level: { type: "uint32", id: 2 },
                    },
                  },
                  // The client calls the SAME operations through two packages:
                  // eve_public.character.skill.plan.* (answered by
                  // skillPlanGatewayService) and eve_public.skill.plan.* (the newer
                  // names its own UI uses). Field numbers and types are identical in
                  // the client's eve_public/skill/plan/plan.proto, so one storage
                  // serves both and the service refuses to start if they ever diverge.
                  GetAllRequest: { fields: {} },
                  GetAllResponse: {
                    fields: {
                      skill_plans: {
                        rule: "repeated",
                        type: "eve_public.skill.plan.Identifier",
                        id: 1,
                      },
                    },
                  },
                  GetRequest: {
                    fields: {
                      skill_plan: { type: "eve_public.skill.plan.Identifier", id: 1 },
                    },
                  },
                  GetResponse: {
                    fields: {
                      skill_plan: { type: "eve_public.skill.plan.Attributes", id: 1 },
                    },
                  },
                  CreateRequest: {
                    fields: {
                      skill_plan: { type: "eve_public.skill.plan.Attributes", id: 1 },
                    },
                  },
                  CreateResponse: {
                    fields: {
                      skill_plan: { type: "eve_public.skill.plan.Identifier", id: 1 },
                    },
                  },
                  SetSkillRequirementsRequest: {
                    fields: {
                      skill_plan: { type: "eve_public.skill.plan.Identifier", id: 1 },
                      requirements: {
                        rule: "repeated",
                        type: "eve_public.skill.plan.SkillRequirement",
                        id: 2,
                      },
                    },
                  },
                  SetSkillRequirementsResponse: { fields: {} },
                  SetNameRequest: {
                    fields: {
                      skill_plan: { type: "eve_public.skill.plan.Identifier", id: 1 },
                      name: { type: "string", id: 2 },
                    },
                  },
                  SetNameResponse: { fields: {} },
                  SetDescriptionRequest: {
                    fields: {
                      skill_plan: { type: "eve_public.skill.plan.Identifier", id: 1 },
                      description: { type: "string", id: 2 },
                    },
                  },
                  SetDescriptionResponse: { fields: {} },
                  DeleteRequest: {
                    fields: {
                      skill_plan: { type: "eve_public.skill.plan.Identifier", id: 1 },
                    },
                  },
                  DeleteResponse: { fields: {} },
                  SetActiveRequest: {
                    fields: {
                      skill_plan: { type: "eve_public.skill.plan.Identifier", id: 1 },
                    },
                  },
                  SetActiveResponse: { fields: {} },
                  milestone: {
                    nested: {
                      Identifier: {
                        fields: {
                          uuid: { type: "bytes", id: 1 },
                        },
                      },
                      Attributes: {
                        oneofs: {
                          milestone: {
                            oneof: ["train_to_type", "skill"],
                          },
                        },
                        fields: {
                          skill_plan: {
                            type: "eve_public.skill.plan.Identifier",
                            id: 1,
                          },
                          train_to_type: {
                            type: "eve_public.inventory.genericitemtype.Identifier",
                            id: 2,
                          },
                          skill: {
                            type: "eve_public.skill.plan.SkillRequirement",
                            id: 3,
                          },
                          description: { type: "string", id: 4 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          character: {
            nested: {
              skill: {
                nested: {
                  plan: {
                    nested: {
                      GetAllRequest: { fields: {} },
                      GetAllResponse: {
                        fields: {
                          skill_plans: {
                            rule: "repeated",
                            type: "eve_public.skill.plan.Identifier",
                            id: 1,
                          },
                        },
                      },
                      GetRequest: {
                        fields: {
                          skill_plan: {
                            type: "eve_public.skill.plan.Identifier",
                            id: 1,
                          },
                        },
                      },
                      GetResponse: {
                        fields: {
                          skill_plan: {
                            type: "eve_public.skill.plan.Attributes",
                            id: 1,
                          },
                        },
                      },
                      GetSharedRequest: {
                        fields: {
                          skill_plan: {
                            type: "eve_public.skill.plan.Identifier",
                            id: 1,
                          },
                        },
                      },
                      GetSharedResponse: {
                        fields: {
                          skill_plan: {
                            type: "eve_public.skill.plan.Attributes",
                            id: 1,
                          },
                        },
                      },
                      CreateRequest: {
                        fields: {
                          skill_plan: {
                            type: "eve_public.skill.plan.Attributes",
                            id: 1,
                          },
                        },
                      },
                      CreateResponse: {
                        fields: {
                          skill_plan: {
                            type: "eve_public.skill.plan.Identifier",
                            id: 1,
                          },
                        },
                      },
                      SetSkillRequirementsRequest: {
                        fields: {
                          skill_plan: {
                            type: "eve_public.skill.plan.Identifier",
                            id: 1,
                          },
                          requirements: {
                            rule: "repeated",
                            type: "eve_public.skill.plan.SkillRequirement",
                            id: 2,
                          },
                        },
                      },
                      SetSkillRequirementsResponse: { fields: {} },
                      SetNameRequest: {
                        fields: {
                          skill_plan: {
                            type: "eve_public.skill.plan.Identifier",
                            id: 1,
                          },
                          name: { type: "string", id: 2 },
                        },
                      },
                      SetNameResponse: { fields: {} },
                      SetDescriptionRequest: {
                        fields: {
                          skill_plan: {
                            type: "eve_public.skill.plan.Identifier",
                            id: 1,
                          },
                          description: { type: "string", id: 2 },
                        },
                      },
                      SetDescriptionResponse: { fields: {} },
                      DeleteRequest: {
                        fields: {
                          skill_plan: {
                            type: "eve_public.skill.plan.Identifier",
                            id: 1,
                          },
                        },
                      },
                      DeleteResponse: { fields: {} },
                      GetActiveRequest: { fields: {} },
                      GetActiveResponse: {
                        fields: {
                          skill_plan: {
                            type: "eve_public.skill.plan.Identifier",
                            id: 1,
                          },
                          skill_plan_info: {
                            type: "eve_public.skill.plan.Attributes",
                            id: 2,
                          },
                        },
                      },
                      SetActiveRequest: {
                        fields: {
                          skill_plan: {
                            type: "eve_public.skill.plan.Identifier",
                            id: 1,
                          },
                        },
                      },
                      SetActiveResponse: { fields: {} },
                      milestone: {
                        nested: {
                          GetAllRequest: {
                            fields: {
                              skill_plan: {
                                type: "eve_public.skill.plan.Identifier",
                                id: 1,
                              },
                            },
                          },
                          GetAllResponse: {
                            fields: {
                              milestones: {
                                rule: "repeated",
                                type:
                                  "eve_public.character.skill.plan.milestone.GetAllResponse.Milestone",
                                id: 1,
                              },
                            },
                            nested: {
                              Milestone: {
                                fields: {
                                  identifier: {
                                    type: "eve_public.skill.plan.milestone.Identifier",
                                    id: 1,
                                  },
                                  data: {
                                    type: "eve_public.skill.plan.milestone.Attributes",
                                    id: 2,
                                  },
                                },
                              },
                            },
                          },
                          CreateRequest: {
                            fields: {
                              milestone: {
                                type: "eve_public.skill.plan.milestone.Attributes",
                                id: 1,
                              },
                            },
                          },
                          CreateResponse: {
                            fields: {
                              milestone: {
                                type: "eve_public.skill.plan.milestone.Identifier",
                                id: 1,
                              },
                            },
                          },
                          DeleteRequest: {
                            fields: {
                              milestone: {
                                type: "eve_public.skill.plan.milestone.Identifier",
                                id: 1,
                              },
                            },
                          },
                          DeleteResponse: { fields: {} },
                          SetDescriptionRequest: {
                            fields: {
                              identifier: {
                                type: "eve_public.skill.plan.milestone.Identifier",
                                id: 1,
                              },
                              description: { type: "string", id: 2 },
                            },
                          },
                          SetDescriptionResponse: { fields: {} },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
}

// The client asks for the same plan operations through two packages. The newer
// eve_public.skill.plan.* names (its own UI) had no handler at all, so creating,
// renaming, retargeting, activating or deleting a plan from that UI did nothing.
// Both packages carry identical messages (client eve_public/skill/plan/plan.proto),
// so they share one storage and one implementation; only the response type name
// differs, and the two are compared at startup so a client change cannot silently
// mis-encode a plan.
const SKILL_PLAN_ALIASES = Object.freeze({
  "eve_public.skill.plan.GetAllRequest":
    "eve_public.character.skill.plan.GetAllRequest",
  "eve_public.skill.plan.GetRequest":
    "eve_public.character.skill.plan.GetRequest",
  "eve_public.skill.plan.CreateRequest":
    "eve_public.character.skill.plan.CreateRequest",
  "eve_public.skill.plan.DeleteRequest":
    "eve_public.character.skill.plan.DeleteRequest",
  "eve_public.skill.plan.SetNameRequest":
    "eve_public.character.skill.plan.SetNameRequest",
  "eve_public.skill.plan.SetDescriptionRequest":
    "eve_public.character.skill.plan.SetDescriptionRequest",
  "eve_public.skill.plan.SetSkillRequirementsRequest":
    "eve_public.character.skill.plan.SetSkillRequirementsRequest",
  "eve_public.skill.plan.SetActiveRequest":
    "eve_public.character.skill.plan.SetActiveRequest",
});;

// Both packages must describe the same wire format, or reusing one payload for the
// other would silently corrupt a plan. Compare field name/type/number of the request
// and its response across the two packages.
function assertAliasShapes(protoRoot) {
  const signature = (type) => type.fieldsArray
    .map((field) => {
      const kind = field.resolvedType
        ? field.resolvedType.fullName.split(".").pop()
        : field.type;
      return `${field.name}:${kind}:${field.id}:${field.repeated ? "repeated" : "single"}`;
    })
    .sort()
    .join("|");

  for (const [aliasType, canonicalType] of Object.entries(SKILL_PLAN_ALIASES)) {
    const aliasRequest = protoRoot.lookupType(aliasType);
    const canonicalRequest = protoRoot.lookupType(canonicalType);
    if (signature(aliasRequest) !== signature(canonicalRequest)) {
      throw Error(`SKILL_PLAN_ALIAS_SHAPE_MISMATCH ${aliasType}`);
    }
    const aliasResponse = protoRoot.lookupType(aliasType.replace(/Request$/, "Response"));
    const canonicalResponse = protoRoot.lookupType(
      canonicalType.replace(/Request$/, "Response"),
    );
    if (signature(aliasResponse) !== signature(canonicalResponse)) {
      throw Error(`SKILL_PLAN_ALIAS_SHAPE_MISMATCH ${aliasType.replace(/Request$/, "Response")}`);
    }
  }
}

module.exports = {
  SKILL_PLAN_ALIASES,
  assertAliasShapes,
  buildSkillPlanProtoRoot,
};