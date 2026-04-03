import { hypeQueue } from "../config/hypeQueue";

async function main(): Promise<void> {
	console.log(
		"[force-purge:hype] pausing queue before obliterate",
	);
	await hypeQueue.pause();

	try {
		console.log(
			"[force-purge:hype] forcefully deleting all jobs from the HyPE queue",
		);
		await hypeQueue.obliterate({
			force: true,
			count: 1000,
		});
		console.log(
			"[force-purge:hype] HyPE queue obliterated successfully",
		);
	} finally {
		await hypeQueue.resume().catch(() => {
			// If the process exits immediately after cleanup, a failed resume should not
			// hide the purge result. The server process will recreate workers on next boot.
		});
	}
}

main()
	.catch((error) => {
		console.error("[force-purge:hype] script failed", {
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
