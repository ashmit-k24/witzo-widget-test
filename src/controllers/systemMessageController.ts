import {
	NextFunction,
	Request,
	Response,
} from "express";
import authService from "../services/authService";
import systemMessageService from "../services/systemMessageService";

function getUserId(req: Request): string | null {
	return req.user?.id || null;
}

export const getSystemMessage = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const settings =
			await systemMessageService.getSettings(userId);
		res.status(200).json({
			success: true,
			data: settings,
		});
	} catch (error) {
		next(error);
	}
};

export const saveCustomSystemMessage = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const settings =
			await systemMessageService.saveCustomSystemMessage(
				userId,
				req.body.systemMessage,
				{
					completeOnboarding:
						req.body.completeOnboarding === true,
					knowledgeBoundary:
						req.body.knowledgeBoundary,
				},
			);
		const user =
			await authService.getProfileStatus(userId);

		res.status(200).json({
			success: true,
			message: "System message saved successfully",
			data: settings,
			user,
		});
	} catch (error) {
		next(error);
	}
};

export const useDefaultSystemMessage = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const settings =
			await systemMessageService.useDefaultSystemMessage(
				userId,
				{
					completeOnboarding:
						req.body.completeOnboarding === true,
					knowledgeBoundary:
						req.body.knowledgeBoundary,
				},
			);
		const user =
			await authService.getProfileStatus(userId);

		res.status(200).json({
			success: true,
			message: "Using default system message",
			data: settings,
			user,
		});
	} catch (error) {
		next(error);
	}
};

export const completeSystemMessageSetup = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	try {
		const userId = getUserId(req);
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const settings =
			await systemMessageService.completeSetup(userId);
		const user =
			await authService.getProfileStatus(userId);

		res.status(200).json({
			success: true,
			message:
				"System message setup completed successfully",
			data: settings,
			user,
		});
	} catch (error) {
		next(error);
	}
};
