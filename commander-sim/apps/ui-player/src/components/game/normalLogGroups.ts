export interface NormalLogActionGroup {
  id: string;
  label: string;
  messages: string[];
}

export interface NormalLogTurnGroup {
  id: string;
  title: string;
  actions: NormalLogActionGroup[];
}

export interface NormalLogGroups {
  policy: string[];
  mulligans: string[];
  setup: string[];
  turns: NormalLogTurnGroup[];
  unassignedActions: NormalLogActionGroup[];
}

const TURN_MARKER = /^\[Turn\]\s*T?(\d+)\s+P(\d+)\b/i;
const ACTION_MARKER = /^\[Action\]\s*(.*)$/i;

export function groupNormalLogMessages(messages: string[]): NormalLogGroups {
  const groups: NormalLogGroups = {
    policy: [],
    mulligans: [],
    setup: [],
    turns: [],
    unassignedActions: [],
  };
  let currentTurn: NormalLogTurnGroup | undefined;
  let currentAction: NormalLogActionGroup | undefined;
  let actionIndex = 0;

  for (const message of messages) {
    if (/^\[(?:policy|Session)\]/i.test(message)) {
      groups.policy.push(message);
      currentAction = undefined;
      continue;
    }
    if (/^\[Mulligan\]/i.test(message)) {
      groups.mulligans.push(message);
      currentAction = undefined;
      continue;
    }

    const turnMatch = message.match(TURN_MARKER);
    if (turnMatch) {
      const turn = turnMatch[1];
      const player = turnMatch[2];
      currentTurn = {
        id: `${turn}-${player}-${groups.turns.length}`,
        title: `T${turn} · P${player}`,
        actions: [],
      };
      groups.turns.push(currentTurn);
      currentAction = undefined;
      continue;
    }

    const actionMatch = message.match(ACTION_MARKER);
    if (actionMatch) {
      currentAction = {
        id: `action-${actionIndex++}`,
        label: actionMatch[1] || "Action",
        messages: [],
      };
      if (currentTurn) currentTurn.actions.push(currentAction);
      else groups.unassignedActions.push(currentAction);
      continue;
    }

    if (!currentTurn) {
      groups.setup.push(message);
      continue;
    }
    if (!currentAction) {
      currentAction = {
        id: `action-${actionIndex++}`,
        label: "Turn events",
        messages: [],
      };
      currentTurn.actions.push(currentAction);
    }
    currentAction.messages.push(message);
  }

  return groups;
}