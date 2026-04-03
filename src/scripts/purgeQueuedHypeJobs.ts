import { hypeQueue } from "../config/hypeQueue";

type QueueJobState =
	| "waiting"
	| "delayed"
	| "prioritized"
	| "paused"
	| "waiting-children";

const TARGET_STATES: QueueJobState[] = [
	"waiting",
	"delayed",
	"prioritized",
	"paused",
	"waiting-children",
];

async function main(): Promise<void> {
	const cutoffTimestamp = Date.now();

	console.log(
		`[purge:hype] scanning stale queued HyPE jobs before ${new Date(cutoffTimestamp).toISOString()}`,
	);

	const [staleQueuedJobs, activeJobs] = await Promise.all([
		hypeQueue.getJobs(TARGET_STATES),
		hypeQueue.getJobs(["active"]),
	]);

	let removedCount = 0;
	let skippedNewerCount = 0;
	let failedRemovals = 0;

	for (const job of staleQueuedJobs) {
		if (job.timestamp > cutoffTimestamp) {
			skippedNewerCount += 1;
			continue;
		}

		try {
			await job.remove();
			removedCount += 1;
		} catch (error) {
			failedRemovals += 1;
			console.error("[purge:hype] failed to remove queued job", {
				jobId: job.id,
				name: job.name,
				timestamp: new Date(job.timestamp).toISOString(),
				error:
					error instanceof Error
						? error.message
						: String(error),
			});
		}
	}

	console.log("[purge:hype] summary", {
		targetedStates: TARGET_STATES,
		queuedJobsSeen: staleQueuedJobs.length,
		removedCount,
		skippedNewerCount,
		activeJobsLeftUntouched: activeJobs.length,
		failedRemovals,
	});

	if (activeJobs.length > 0) {
		console.log(
			"[purge:hype] active HyPE jobs were not removed. Let them finish or stop the worker before purging again if needed.",
		);
	}
}

main()
	.catch((error) => {
		console.error("[purge:hype] script failed", {
			error:
				error instanceof Error
					? error.message
					: String(error),
		});
		process.exitCode = 1;
	})
	.finally(async () => {
		await hypeQueue.close();
	});
