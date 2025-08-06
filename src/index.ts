import { rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { unwrap } from "@vortexjs/common";
import { randomUUIDv7 } from "bun";

export type TrialExport = {
    importedFrom: string;
    name: string;
};

export type TaggedTrialExport = TrialExport & {
    means: "static" | "dynamic";
};

export type TrialModule = {
    type: "ecma";
    id: string;

    originals: string[];
    imports: TaggedTrialExport[];
    sideEffects: string[]; // just a bunch of calls to trial exports
    exports: TrialExport[];
};

declare global {
    var traces: Record<string, string[]>;
}

globalThis.traces ??= {};

function random(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
function* repeat(times: number) {
    for (let i = 0; i < times; i++) {
        yield i;
    }
}
function pick<T>(...items: T[]): T {
    return unwrap(items[random(0, items.length - 1)]);
}

function categorizeError(err: unknown): string {
    const realErr = `${err}`;
    const categories = [
        "duplicate",
        "cannot find module",
        "is not a function",
        "expected side effect",
    ];
    for (const category of categories) {
        if (realErr.toLowerCase().includes(category)) {
            return category;
        }
    }
    throw new Error(`Unknown error category for: ${realErr}`);
}

let builds = 0;

export class Trial {
    id = randomUUIDv7();
    path = resolve("./trials", this.id);
    pathCodegen = resolve(this.path, "codegen");
    pathOutput = resolve(this.path, "output");
    entrypoints: TrialModule[] = [];

    modules: TrialModule[] = [];

    internalIdIncrementor = 0;

    getInternalId() {
        return `e${(this.internalIdIncrementor++).toString(36)}`;
    }

    seedInitialModules() {
        for (const _i of repeat(random(2, 5))) {
            this.modules.push({
                type: "ecma",
                id: this.getInternalId(),

                exports: [],
                imports: [],
                sideEffects: [],
                originals: [],
            });
        }
    }

    addOriginalExports() {
        for (const module of this.modules) {
            for (const _i of repeat(random(1, 5))) {
                const exp = {
                    importedFrom: module.id,
                    name: `export_${this.getInternalId()}`,
                };
                module.originals.push(exp.name);
                module.exports.push(exp);
            }
        }
    }

    importIntoModule(exported: TrialExport, targetModule: TrialModule): string {
        // make sure we don't import the same export twice
        for (const existingImport of targetModule.imports) {
            if (existingImport.name === exported.name) {
                return existingImport.name;
            }
        }

        if (targetModule.originals.includes(exported.name)) {
            return exported.name; // already an original export
        }

        const taggedExport: TaggedTrialExport = {
            ...exported,
            means: pick("static", "dynamic"),
        };

        targetModule.imports.push(taggedExport);

        return taggedExport.name;
    }

    pickRandomExport() {
        const allExports = this.modules.flatMap((module) => module.exports);
        return pick(...allExports);
    }

    addReExports() {
        for (const module of this.modules) {
            for (const _i of repeat(random(0, 5))) {
                const imp = this.pickRandomExport();
                if (module.originals.includes(imp.name)) continue;
                const name = this.importIntoModule(imp, module);
                module.exports.push({
                    importedFrom: module.id,
                    name,
                });
            }
        }
    }

    addSideEffects() {
        for (const module of this.modules) {
            for (const _i of repeat(random(0, 5))) {
                const imp = this.pickRandomExport();
                if (module.originals.includes(imp.name)) continue;
                const name = this.importIntoModule(imp, module);
                module.sideEffects.push(name);
            }
        }
    }

    codegenModule(module: TrialModule): string {
        const lines: string[] = [];

        // Originals
        for (const original of module.originals) {
            lines.push(`function ${original}() {`);
            lines.push(`\tglobalThis.traces[${JSON.stringify(this.id)}] ??= []`);
            lines.push(
                `\tglobalThis.traces[${JSON.stringify(this.id)}].push(${JSON.stringify(original)})`,
            );
            lines.push(`}`);
        }

        // Imports
        for (const imp of module.imports) {
            if (imp.means === "static") {
                lines.push(
                    `import { ${imp.name} } from ${JSON.stringify("./" + imp.importedFrom)};`,
                );
            } else if (imp.means === "dynamic") {
                lines.push(
                    `const { ${imp.name} } = await import(${JSON.stringify("./" + imp.importedFrom)});`,
                );
            }
        }

        // Side effects
        for (const sideEffect of module.sideEffects) {
            lines.push(`${sideEffect}();`);
        }

        // Exports
        if (module.exports.length > 0) {
            const deduplicated = new Set(module.exports.map((exp) => exp.name));
            const exportsLine = `export { ${[...deduplicated].join(", ")} };`;
            lines.push(exportsLine);
        }

        return lines.join("\n");
    }

    chooseEntrypoints() {
        // Shuffle modules
        const shuffledModules = this.modules.sort(() => Math.random() - 0.5);
        const numEntrypoints = random(1, Math.min(3, shuffledModules.length));
        this.entrypoints = shuffledModules.slice(0, numEntrypoints);
    }

    analyzeSideEffects(
        id: string,
        traced: string[] = [],
        effects: Set<string> = new Set(),
    ): Set<string> {
        const module = this.modules.find((m) => m.id === id);
        if (!module) return effects;
        if (traced.includes(module.id)) return effects; // Avoid cycles
        traced.push(module.id);

        for (const sideEffect of module.sideEffects) {
            effects.add(sideEffect);
            this.analyzeSideEffects(sideEffect, traced, effects);
        }

        for (const imp of module.imports) {
            this.analyzeSideEffects(imp.importedFrom, traced, effects);
        }

        return effects;
    }

    async generateReproduction(failure: string) {
        const lines: string[] = [];
        let printedGap = false;
        let indentLevel = 0;
        function line(text: string) {
            if (text.includes("\n")) {
                const lines = text.split("\n");
                for (const ln of lines) {
                    line(ln);
                }
                return;
            }

            lines.push("    ".repeat(indentLevel) + text);
            printedGap = false;
        }
        function gap() {
            if (!printedGap) {
                lines.push("");
                printedGap = true;
            }
        }
        function indent() {
            indentLevel++;
        }
        function dedent() {
            indentLevel = Math.max(0, indentLevel - 1);
        }

        line(`# Bundler bug reproduction`);
        line(`## Metadata`);
        gap();
        indent();
        line(`- Bun version: ${Bun.version_with_sha}`);
        line(`- Platform: ${process.platform}`);
        gap();
        dedent();
        line(`## Files`);
        gap();
        indent();
        for (const module of this.modules) {
            gap();
            line(`### ${module.id}.ts`);
            line(`\`\`\`typescript`);
            line(await Bun.file(join(this.pathCodegen, module.id + ".ts")).text());
            line(`\`\`\``);
            gap();
        }
        dedent();

        gap();
        line(`## Entrypoints`);
        gap();
        indent();
        for (const entrypoint of this.entrypoints) {
            line(`- ${entrypoint.id}.ts`);
        }
        dedent();

        gap();
        line(`## Failure`);
        indent();
        gap();
        line(`${failure}`);
        dedent();

        return lines.join("\n");
    }

    async run() {
        // Phase 1: Plan out all our modules
        this.seedInitialModules();
        this.addOriginalExports();
        this.addReExports();
        this.addSideEffects();
        this.chooseEntrypoints();

        // Phase 2: Write out the code for each module
        for (const module of this.modules) {
            await Bun.write(
                join(this.pathCodegen, module.id + ".ts"),
                this.codegenModule(module),
            );
        }

        // Phase 3: Build
        await Bun.build({
            entrypoints: this.entrypoints.map((module) =>
                join(this.pathCodegen, module.id + ".ts"),
            ),
            outdir: this.pathOutput,
            splitting: true,
        });

        // Phase 4: Determine side effects that should be occuring
        const expectedSideEffects = this.analyzeSideEffects(
            unwrap(this.entrypoints[0]).id,
        );

        try {
            await import(
                join(this.pathOutput, unwrap(this.entrypoints[0]).id + ".js")
            );

            const sideEffects = globalThis.traces[this.id] ?? [];

            for (const effect of expectedSideEffects) {
                if (!sideEffects.includes(effect)) {
                    throw `Expected side effect "${effect}" not found in traces for ${this.id}.`;
                }
            }
        } catch (err) {
            const repro = await this.generateReproduction(`${err}`);

            const category = categorizeError(err);

            try {
                const currentRepro = await Bun.file(
                    join("./repros", category + ".md"),
                ).text();

                if (currentRepro.length < repro.length) {
                    return;
                }
            } catch { }

            await Bun.write(join("./repros", category + ".md"), repro);
        }
    }

    async cleanup() {
        await rmdir(this.path, { recursive: true });
    }
}

async function grinderThread() {
    while (true) {
        const trial = new Trial();
        await trial.run();
        //trial.cleanup();
        builds++;
    }
}

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const i of repeat(64)) {
    grinderThread();
}

let totalBuilds = 0;
while (true) {
    const thisTime = builds;
    builds = 0;
    console.log(`Builds this second: ${thisTime}`);
    totalBuilds += thisTime;
    console.log(`Total builds: ${totalBuilds}`);
    await wait(1000);
}
