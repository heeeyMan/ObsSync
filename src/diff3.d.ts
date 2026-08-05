// `diff3` (node-diff3's core) is isomorphic-git's own merge dependency but ships
// no type declarations. We re-use it for the text side of our binary-safe merge
// driver so text merges stay byte-for-byte identical to isomorphic-git's default.
declare module "diff3" {
	interface Diff3Hunk {
		/** A cleanly-merged run of lines (each line still carries its EOL). */
		ok?: string[];
		/** A conflicting region: `a` = ours, `b` = theirs, `o` = base. */
		conflict?: {
			a: string[];
			aIndex: number;
			o: string[];
			oIndex: number;
			b: string[];
			bIndex: number;
		};
	}
	export default function diff3Merge(
		a: string[],
		o: string[],
		b: string[]
	): Diff3Hunk[];
}
