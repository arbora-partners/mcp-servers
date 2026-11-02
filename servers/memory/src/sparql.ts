/**
 * Building SPARQL text without string injection.
 *
 * `sparql` is a tagged template whose holes accept only RDF/JS terms, other
 * fragments, or arrays of either: there is no way to splice a raw string into
 * a query. Each term is serialized by `@rdfjs/to-ntriples`, whose N-Triples
 * term syntax is valid SPARQL term syntax. That serializer escapes a literal's
 * lexical form (quotes, backslashes, line breaks) but writes an IRI verbatim,
 * so every IRI is checked here against the IRIREF production first.
 */

import toNT from "@rdfjs/to-ntriples";
import type { Term } from "@rdfjs/types";

const FRAGMENT = Symbol("sparql-fragment");

export interface Fragment {
  readonly [FRAGMENT]: true;
  readonly text: string;
}

type Hole = Term | Fragment | readonly (Term | Fragment)[];

// Characters SPARQL's IRIREF excludes: `<>"{}|^\`\\` and U+0000–U+0020.
const IRI_FORBIDDEN = new Set(["<", ">", '"', "{", "}", "|", "^", "`", "\\"]);

/** Whether `iri` can be written as `<iri>` without escaping (SPARQL IRIREF). */
function isIriRef(iri: string): boolean {
  for (const c of iri) {
    if (c.charCodeAt(0) <= 0x20 || IRI_FORBIDDEN.has(c)) return false;
  }
  return true;
}

function isFragment(hole: unknown): hole is Fragment {
  return typeof hole === "object" && hole !== null && FRAGMENT in hole;
}

function serializeTerm(term: Term): string {
  switch (term.termType) {
    case "NamedNode":
      if (!isIriRef(term.value))
        throw new Error(`not a valid IRI: ${JSON.stringify(term.value)}`);
      return toNT(term);
    case "Literal":
      if (!isIriRef(term.datatype.value)) {
        throw new Error(
          `not a valid datatype IRI: ${JSON.stringify(term.datatype.value)}`,
        );
      }
      return toNT(term);
    default:
      throw new Error(`unsupported term in a query: ${term.termType}`);
  }
}

function serializeHole(hole: Hole): string {
  if (Array.isArray(hole)) return hole.map((h) => serializeHole(h)).join(" ");
  if (isFragment(hole)) return hole.text;
  if (typeof hole === "object" && hole !== null && "termType" in hole) {
    return serializeTerm(hole as Term);
  }
  // Unreachable through the types; refuse at run time too.
  throw new Error("a SPARQL hole must be an RDF term or a fragment");
}

export function sparql(
  strings: TemplateStringsArray,
  ...holes: Hole[]
): Fragment {
  let text = strings[0] ?? "";
  holes.forEach((hole, i) => {
    text += serializeHole(hole) + (strings[i + 1] ?? "");
  });
  return { [FRAGMENT]: true, text };
}
