// A system is observed by the war layer only if something there proves it: a
// client arrived, or the durable war roster holds real native hulls in it. The
// roster case matters because a spawned war fleet creates a real scene in a
// system nobody flew into; without it the opening planner, the mobilizer and the
// battle director never saw that fleet, so the war could not start or advance
// without a human flying the route.
//
// Read-only: this decides which systems the war layer looks at, never what is
// true inside them.
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function fleetSystemIDs(snapshot) {
  const fleets = snapshot && snapshot.state && snapshot.state.fleets;
  if (!fleets || typeof fleets !== "object") return [];
  const systems = new Set();
  for (const fleet of Object.values(fleets)) {
    if (!fleet || typeof fleet !== "object") continue;
    // A destroyed or reconstituted formation is history, not presence.
    if (fleet.state === "DESTROYED" || fleet.state === "RECONSTITUTED") continue;
    const systemID = Number(fleet.systemID) || 0;
    if (!pos(systemID)) continue;
    const ships = Array.isArray(fleet.ships) ? fleet.ships : [];
    // A fleet with no hull left cannot make its system observed.
    const alive = ships.some((ship) => ship && (ship.state === "ALIVE" || ship.state === "ADOPTED"));
    if (!alive) continue;
    systems.add(systemID);
  }
  return [...systems];
}

module.exports = { fleetSystemIDs };
