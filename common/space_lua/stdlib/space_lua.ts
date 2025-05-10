import { parseExpressionString } from "$common/space_lua/parse.ts";
import type { LuaExpression } from "$common/space_lua/ast.ts";
import { evalExpression } from "$common/space_lua/eval.ts";
import { parseMarkdown } from "$common/markdown_parser/parser.ts";
import {
  LuaBuiltinFunction,
  LuaEnv,
  LuaRuntimeError,
  type LuaStackFrame,
  LuaTable,
  luaToString,
  luaValueToJS,
  singleResult,
} from "$common/space_lua/runtime.ts";
import {
  findNodeOfType,
  type ParseTree,
  renderToText,
  replaceNodesMatchingAsync,
} from "@silverbulletmd/silverbullet/lib/tree";

/**
 * These are Space Lua specific functions that are available to all scripts, but are not part of the standard Lua language.
 */

/**
 * Helper function to create an augmented environment
 */
function createAugmentedEnv(
  sf: LuaStackFrame,
  envAugmentation?: LuaTable,
): LuaEnv {
  const globalEnv = sf.threadLocal.get("_GLOBAL");
  if (!globalEnv) {
    throw new Error("_GLOBAL not defined");
  }
  const env = new LuaEnv(globalEnv);
  if (envAugmentation) {
    env.setLocal("_", envAugmentation);
    for (const key of envAugmentation.keys()) {
      env.setLocal(key, envAugmentation.rawGet(key));
    }
  }
  return env;
}

/**
 * Helper function to evaluate lua expressions
 */
async function evaluateExpression(
  sf: LuaStackFrame,
  expr: string,
  envAugmentation?: LuaTable,
): Promise<ParseTree> {
  try {
    const parsedExpr = parseExpressionString(expr);
    const env = createAugmentedEnv(sf, envAugmentation);
    const luaResult = await luaValueToJS(
      singleResult(await evalExpression(parsedExpr, env, sf)),
      sf,
    );
    const result = await luaToString(luaResult);
    return parseMarkdown(result);
  } catch (e: any) {
    throw new LuaRuntimeError(
      `Error evaluating "${expr}": ${e.message}`,
      sf,
    );
  }
}

/**
 * Interpolates a string with lua expressions and returns the result.
 *
 * @param sf - The current space_lua state.
 * @param template - The template string to interpolate.
 * @param envAugmentation - An optional environment to augment the global environment with.
 * @returns The interpolated string.
 */
export async function interpolateLuaString(
  sf: LuaStackFrame,
  template: string,
  envAugmentation?: LuaTable,
): Promise<string> {
  let parsed = parseMarkdown(template);

  await replaceNodesMatchingAsync(parsed, async (n) => {
    if (n.type === "LuaDirective") {
      const expressionNode = findNodeOfType(n, "LuaExpressionDirective");

      if (expressionNode) {
        return evaluateExpression(
          sf,
          renderToText(expressionNode),
          envAugmentation,
        );
      }
    } else if (n.type === "Escape" && renderToText(n) === "\\$") {
      return parseMarkdown("$");
    } else if (n.type === "WikiLinkPage") {
      const wikiLink = renderToText(n);
      const parsedWikiLink = parseMarkdown(wikiLink);
      const expressionNode = findNodeOfType(
        parsedWikiLink,
        "LuaExpressionDirective",
      );

      if (expressionNode) {
        return evaluateExpression(
          sf,
          renderToText(expressionNode),
          envAugmentation,
        );
      }
    }

    return undefined;
  });

  return renderToText(parsed);
}

export const spaceluaApi = new LuaTable({
  /**
   * Parses a lua expression and returns the parsed expression.
   *
   * @param sf - The current space_lua state.
   * @param luaExpression - The lua expression to parse.
   * @returns The parsed expression.
   */
  parseExpression: new LuaBuiltinFunction(
    (_sf, luaExpression: string) => {
      return parseExpressionString(luaExpression);
    },
  ),
  /**
   * Evaluates a parsed lua expression and returns the result.
   *
   * @param sf - The current space_lua state.
   * @param parsedExpr - The parsed lua expression to evaluate.
   * @param envAugmentation - An optional environment to augment the global environment with.
   * @returns The result of the evaluated expression.
   */
  evalExpression: new LuaBuiltinFunction(
    async (sf, parsedExpr: LuaExpression, envAugmentation?: LuaTable) => {
      const env = createAugmentedEnv(sf, envAugmentation);
      return luaValueToJS(await evalExpression(parsedExpr, env, sf), sf);
    },
  ),
  /**
   * Interpolates a string with lua expressions and returns the result.
   */
  interpolate: new LuaBuiltinFunction(
    (sf, template: string, envAugmentation?: LuaTable) => {
      return interpolateLuaString(sf, template, envAugmentation);
    },
  ),
  /**
   * Returns your SilverBullet instance's base URL, or `undefined` when run on the server
   */
  baseUrl: new LuaBuiltinFunction(
    () => {
      // Deal with Deno
      if (typeof location === "undefined") {
        return null;
      } else {
        return location.protocol + "//" + location.host;
      }
    },
  ),
});
