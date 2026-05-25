export function stableStringify(value) {
    return JSON.stringify(sortForJson(value));
}
export function sortForJson(value) {
    if (Array.isArray(value)) {
        return value.map(sortForJson);
    }
    if (value && typeof value === "object") {
        const sorted = {};
        for (const key of Object.keys(value).sort(compareCodePointStrings)) {
            sorted[key] = sortForJson(value[key]);
        }
        return sorted;
    }
    return value;
}
function compareCodePointStrings(left, right) {
    const leftCodePoints = Array.from(left);
    const rightCodePoints = Array.from(right);
    const length = Math.min(leftCodePoints.length, rightCodePoints.length);
    for (let index = 0; index < length; index += 1) {
        const leftPoint = leftCodePoints[index]?.codePointAt(0) ?? 0;
        const rightPoint = rightCodePoints[index]?.codePointAt(0) ?? 0;
        if (leftPoint !== rightPoint)
            return leftPoint - rightPoint;
    }
    return leftCodePoints.length - rightCodePoints.length;
}
export function parseDuration(value) {
    const trimmed = value.trim();
    const matches = [...trimmed.matchAll(/(\d+)(ms|s|m|h|d)/g)];
    if (matches.length === 0 || matches.map((match) => match[0]).join("") !== trimmed) {
        throw new Error(`Invalid duration: ${value}`);
    }
    const order = ["d", "h", "m", "s", "ms"];
    let previousIndex = -1;
    const seen = new Set();
    const multipliers = {
        ms: 1,
        s: 1000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000
    };
    return matches.reduce((total, match) => {
        const amount = Number(match[1] ?? "0");
        const unit = match[2] ?? "";
        if (seen.has(unit)) {
            throw new Error(`Duplicate duration unit in: ${value}`);
        }
        seen.add(unit);
        const index = order.indexOf(unit);
        if (index < previousIndex) {
            throw new Error(`Invalid duration unit order: ${value}`);
        }
        previousIndex = index;
        const multiplier = multipliers[unit];
        if (multiplier === undefined) {
            throw new Error(`Invalid duration: ${value}`);
        }
        return total + amount * multiplier;
    }, 0);
}
//# sourceMappingURL=utils.js.map