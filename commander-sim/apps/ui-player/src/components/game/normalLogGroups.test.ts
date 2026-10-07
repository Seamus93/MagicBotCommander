import { describe, expect, it } from "vitest";
import { groupNormalLogMessages } from "./normalLogGroups";

describe("groupNormalLogMessages", () => {
  it("separates policy and mulligans before grouping turn actions", () => {
    const groups = groupNormalLogMessages([
      "[policy] live_source=db records=218016",
      "[Session] mode=ALL_AI",
      "[Mulligan] Player 0 keeps (mulliganCount=0)",
      "[Turn] T1 P0",
      "Player 0 plays land Mountain untapped",
      "[Action] CAST_SPELL Pyre of Heroes",
      "[Mana] payment Pyre of Heroes: Mountain -> {R}",
      "Player 0 casts Pyre of Heroes",
      "[Turn] T1 P1",
      "Player 1 plays land Swamp untapped",
    ]);

    expect(groups.policy).toHaveLength(2);
    expect(groups.mulligans).toHaveLength(1);
    expect(groups.turns).toHaveLength(2);
    expect(groups.turns[0]).toMatchObject({
      title: "T1 · P0",
      actions: [
        { label: "Turn events", messages: ["Player 0 plays land Mountain untapped"] },
        {
          label: "CAST_SPELL Pyre of Heroes",
          messages: [
            "[Mana] payment Pyre of Heroes: Mountain -> {R}",
            "Player 0 casts Pyre of Heroes",
          ],
        },
      ],
    });
    expect(groups.turns[1].title).toBe("T1 · P1");
  });

  it("keeps messages from an older unmarked log readable", () => {
    const groups = groupNormalLogMessages([
      "Player 0 plays land Mountain untapped",
      "Reason: no tapped entry restriction",
    ]);

    expect(groups.setup).toEqual([
      "Player 0 plays land Mountain untapped",
      "Reason: no tapped entry restriction",
    ]);
  });
});