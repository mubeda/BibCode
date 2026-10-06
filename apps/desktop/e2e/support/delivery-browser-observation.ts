// @effect-diagnostics nodeBuiltinImport:off - Development-only closed diagnostics use the contracts package's actual Schema runtime.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
interface RuntimeSchema<A> {
  readonly Type: A;
}
const Schema: {
  readonly Unknown: RuntimeSchema<unknown>;
  readonly Boolean: RuntimeSchema<boolean>;
  NullOr<A>(schema: RuntimeSchema<A>): RuntimeSchema<A | null>;
  Struct<Fields extends Record<string, RuntimeSchema<unknown>>>(
    fields: Fields,
  ): RuntimeSchema<{ [Key in keyof Fields]: Fields[Key]["Type"] }>;
  decodeUnknownSync<A>(schema: RuntimeSchema<A>): (input: unknown) => A;
} = NodeModule.createRequire(
  NodePath.resolve(import.meta.dirname, "../../../../packages/contracts/package.json"),
)("effect/Schema");
const nullableBoolean = Schema.NullOr(Schema.Boolean);
const PrViewportObservation = Schema.Struct({
  viewportReadReturned: nullableBoolean,
  viewportNumbersFinite: nullableBoolean,
  viewportDimensionsPositive: nullableBoolean,
  viewportScaleOne: nullableBoolean,
  outerReadReturned: nullableBoolean,
  outerDimensionsPositive: nullableBoolean,
  correctionFinitePositive: nullableBoolean,
  resizeReturned: nullableBoolean,
  lastViewportExact: nullableBoolean,
});
export type PrViewportObservation = typeof PrViewportObservation.Type;
const ModelClickObservation = Schema.Struct({
  modelRowCountOne: nullableBoolean,
  modelRowRoleOption: nullableBoolean,
  modelRowDisplayed: nullableBoolean,
  modelRowCenterInViewport: nullableBoolean,
  modelRowCenterHitsRow: nullableBoolean,
  modelRowCenterHitsFavorite: nullableBoolean,
  composerTriggerCountOne: nullableBoolean,
  triggerLabelExpected: nullableBoolean,
});
export type ModelClickObservation = typeof ModelClickObservation.Type;
const ViewportNumbers = Schema.Struct({
  width: Schema.Unknown,
  height: Schema.Unknown,
  devicePixelRatio: Schema.Unknown,
});
const SizeNumbers = Schema.Struct({ width: Schema.Unknown, height: Schema.Unknown });
const decodeViewport = Schema.decodeUnknownSync(ViewportNumbers);
const decodeSize = Schema.decodeUnknownSync(SizeNumbers);
const decodePrFacts = Schema.decodeUnknownSync(PrViewportObservation);
const decodeModelFacts = Schema.decodeUnknownSync(ModelClickObservation);
function ownData(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || NodeUtil.types.isProxy(input) || Array.isArray(input))
    return null;
  const actual = Reflect.ownKeys(input);
  if (
    actual.length !== keys.length ||
    !actual.every((key) => typeof key === "string" && keys.includes(key))
  )
    return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) return null;
    result[key] = field.value;
  }
  return result;
}
export function projectPrViewportObservation(input: unknown): PrViewportObservation | null {
  try {
    const safe = ownData(input, [
      "viewportReadReturned",
      "viewportNumbersFinite",
      "viewportDimensionsPositive",
      "viewportScaleOne",
      "outerReadReturned",
      "outerDimensionsPositive",
      "correctionFinitePositive",
      "resizeReturned",
      "lastViewportExact",
    ]);
    return safe ? Object.freeze(decodePrFacts(safe)) : null;
  } catch {
    return null;
  }
}
export function projectModelClickObservation(input: unknown): ModelClickObservation | null {
  try {
    const safe = ownData(input, [
      "modelRowCountOne",
      "modelRowRoleOption",
      "modelRowDisplayed",
      "modelRowCenterInViewport",
      "modelRowCenterHitsRow",
      "modelRowCenterHitsFavorite",
      "composerTriggerCountOne",
      "triggerLabelExpected",
    ]);
    return safe ? Object.freeze(decodeModelFacts(safe)) : null;
  } catch {
    return null;
  }
}
export function observePrViewportNumbers(input: unknown) {
  try {
    const safe = ownData(input, ["width", "height", "devicePixelRatio"]);
    if (!safe) return null;
    const value = decodeViewport(safe);
    const finite =
      typeof value.width === "number" &&
      Number.isFinite(value.width) &&
      typeof value.height === "number" &&
      Number.isFinite(value.height) &&
      typeof value.devicePixelRatio === "number" &&
      Number.isFinite(value.devicePixelRatio);
    return {
      viewportNumbersFinite: finite,
      viewportDimensionsPositive:
        typeof value.width === "number" && typeof value.height === "number"
          ? value.width > 0 && value.height > 0
          : null,
      viewportScaleOne:
        typeof value.devicePixelRatio === "number" ? value.devicePixelRatio === 1 : null,
    };
  } catch {
    return null;
  }
}
export function observePrOuterNumbers(input: unknown): boolean | null {
  try {
    const safe = ownData(input, ["width", "height"]);
    if (!safe) return null;
    const value = decodeSize(safe);
    return (
      typeof value.width === "number" &&
      Number.isFinite(value.width) &&
      typeof value.height === "number" &&
      Number.isFinite(value.height) &&
      value.width > 0 &&
      value.height > 0
    );
  } catch {
    return null;
  }
}
/** One Settings-only pre-click sample. The exact option/trigger literals are owned by the current public components. */
export function readDeliveryModelClickObservation(
  expectedOrigin: string,
): ModelClickObservation | null {
  try {
    if (
      expectedOrigin !== "http://127.0.0.1:4885" ||
      location.origin !== expectedOrigin ||
      location.search !== "" ||
      location.hash !== "" ||
      !/^\/local\/[A-Za-z0-9._:-]{1,128}$/.test(location.pathname) ||
      document.querySelector(
        '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
      )
    )
      return null;
    const facts: ModelClickObservation = {
      modelRowCountOne: null,
      modelRowRoleOption: null,
      modelRowDisplayed: null,
      modelRowCenterInViewport: null,
      modelRowCenterHitsRow: null,
      modelRowCenterHitsFavorite: null,
      composerTriggerCountOne: null,
      triggerLabelExpected: null,
    };
    const rows = document.querySelectorAll(
      '[data-model-picker-content="true"] [data-model-picker-instance-id="claudeAgent"][data-model-picker-model-slug="opus"]',
    );
    facts.modelRowCountOne = rows.length === 1;
    const triggers = document.querySelectorAll(
      '[data-center-surface-host][data-visible="true"] [data-chat-composer-form="true"] [data-chat-provider-model-picker="true"]',
    );
    facts.composerTriggerCountOne = triggers.length === 1;
    if (triggers.length === 1)
      facts.triggerLabelExpected = triggers[0]!.getAttribute("aria-label") === "Claude · Opus 5";
    if (rows.length !== 1) return facts;
    const row = rows[0]!;
    facts.modelRowRoleOption = row.getAttribute("role") === "option";
    const rectangle = row.getBoundingClientRect();
    if (
      ![
        rectangle.left,
        rectangle.top,
        rectangle.width,
        rectangle.height,
        innerWidth,
        innerHeight,
      ].every((value) => typeof value === "number" && Number.isFinite(value))
    )
      return facts;
    let displayed = rectangle.width > 0 && rectangle.height > 0;
    for (let ancestor: Element | null = row; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert")) displayed = false;
      const style = getComputedStyle(ancestor);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
        displayed = false;
    }
    facts.modelRowDisplayed = displayed;
    const x = rectangle.left + rectangle.width / 2,
      y = rectangle.top + rectangle.height / 2;
    facts.modelRowCenterInViewport =
      rectangle.width > 0 &&
      rectangle.height > 0 &&
      x >= 0 &&
      y >= 0 &&
      x < innerWidth &&
      y < innerHeight;
    if (facts.modelRowCenterInViewport) {
      const hit = document.elementFromPoint(x, y);
      facts.modelRowCenterHitsRow = hit !== null && (hit === row || row.contains(hit));
      const favorite = row.querySelector(
        'button[aria-label="Add to favorites"],button[aria-label="Remove from favorites"]',
      );
      facts.modelRowCenterHitsFavorite =
        favorite !== null && hit !== null && (hit === favorite || favorite.contains(hit));
    }
    return facts;
  } catch {
    return null;
  }
}
