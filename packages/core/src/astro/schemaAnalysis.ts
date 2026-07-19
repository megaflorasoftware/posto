export interface SchemaImageField {
  path: string[];
  /** Imports can assign this field without having to invent list items. */
  writable: boolean;
}

function imageFields(source: string): SchemaImageField[] {
  const fields: SchemaImageField[] = [];
  const walk = (block: string, prefix: string[], insideList = false) => {
    const property = /(?:(['"`])([^'"`]+)\1|([A-Za-z_$][\w$]*))\s*:/g;
    for (let match = property.exec(block); match; match = property.exec(block)) {
      const name = match[2] ?? match[3];
      let start = property.lastIndex;
      while (/\s/.test(block[start] ?? "")) start++;
      let end = start;
      let braces = 0, parens = 0, brackets = 0;
      let quote: string | null = null;
      for (; end < block.length; end++) {
        const char = block[end];
        if (quote) {
          if (char === "\\") end++;
          else if (char === quote) quote = null;
          continue;
        }
        if (char === '"' || char === "'" || char === "`") quote = char;
        else if (char === "{") braces++;
        else if (char === "}") { if (braces === 0 && parens === 0 && brackets === 0) break; braces--; }
        else if (char === "(") parens++;
        else if (char === ")") parens--;
        else if (char === "[") brackets++;
        else if (char === "]") brackets--;
        else if (char === "," && braces === 0 && parens === 0 && brackets === 0) break;
      }
      const value = block.slice(start, end).trim();
      const listWrapped = /^(?:z\s*\.\s*)?array\s*\(/.test(value);
      if (/^(?:(?:z\s*\.\s*)?array\s*\(\s*)*(?:image|\w+\s*\.\s*image)\s*\(/.test(value)) {
        fields.push({ path: [...prefix, name], writable: !insideList && !listWrapped });
      } else {
        const object = value.match(/(?:z\s*\.\s*)?object\s*\(\s*\{/);
        const plain = !object && value.startsWith("{") ? 0 : -1;
        const open = object ? value.indexOf("{", object.index) : plain;
        if (open >= 0) {
          let depth = 0;
          let close = -1;
          for (let index = open; index < value.length; index++) {
            if (value[index] === "{") depth++;
            else if (value[index] === "}" && --depth === 0) { close = index; break; }
          }
          if (close > open) {
            walk(
              value.slice(open + 1, close),
              name === "schema" ? prefix : [...prefix, name],
              insideList || listWrapped,
            );
          }
        }
      }
      property.lastIndex = Math.max(property.lastIndex, end + 1);
    }
  };
  walk(source, []);
  return fields;
}

function declaredSchemaSource(source: string, identifier: string): string | null {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const constant = new RegExp(`(?:export\\s+)?const\\s+${escaped}\\s*=`).exec(source);
  if (constant) {
    let parens = 0, braces = 0, brackets = 0;
    let quote: string | null = null;
    for (let index = constant.index; index < source.length; index++) {
      const char = source[index];
      if (quote) {
        if (char === "\\") index++;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(") parens++;
      else if (char === ")") parens--;
      else if (char === "{") braces++;
      else if (char === "}") braces--;
      else if (char === "[") brackets++;
      else if (char === "]") brackets--;
      else if (char === ";" && parens === 0 && braces === 0 && brackets === 0) {
        return source.slice(constant.index, index + 1);
      }
    }
  }
  const fn = new RegExp(`(?:export\\s+)?function\\s+${escaped}\\s*\\(`).exec(source);
  if (!fn) return null;
  const open = source.indexOf("{", fn.index);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return source.slice(fn.index, index + 1);
  }
  return null;
}

/** Best-effort static adapter for ordinary inline or same-file Astro schemas.
 * Keeping source syntax inspection here prevents it from leaking into the
 * canonical collection and image-library models. */
export function schemaImageFields(
  configSource: string,
  collectionBody: string,
  schemaExpression?: string,
): SchemaImageField[] {
  const inline = imageFields(collectionBody);
  if (inline.length > 0 || !schemaExpression || !/^[A-Za-z_$][\w$]*$/.test(schemaExpression)) {
    return inline;
  }
  const declaration = declaredSchemaSource(configSource, schemaExpression);
  return declaration ? imageFields(declaration) : [];
}
