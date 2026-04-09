import { Request, Response } from "express";
import personaService from "../services/personaService";
import logger from "../utils/logger";

export async function listPersonas(
	_req: Request,
	res: Response,
): Promise<void> {
	try {
		const personas =
			await personaService.listPersonas(false);
		res.status(200).json({
			success: true,
			data: { personas },
		});
	} catch (error) {
		logger.error("Error listing widget personas", { error });
		res.status(500).json({
			success: false,
			message: "Failed to load personas",
		});
	}
}

export async function selectPersona(
	req: Request,
	res: Response,
): Promise<void> {
	try {
		await personaService.setUserPersona(
			req.user!.id,
			req.body.personaKey,
			{
				manualOverride: true,
				autoDetected: false,
			},
		);
		res.status(200).json({
			success: true,
			message: "Persona updated",
		});
	} catch (error) {
		logger.error("Error selecting widget persona", {
			error,
			userId: req.user?.id,
		});
		res.status(500).json({
			success: false,
			message: "Failed to update persona",
		});
	}
}

export async function adminListPersonas(
	_req: Request,
	res: Response,
): Promise<void> {
	try {
		const personas =
			await personaService.listPersonas(true);
		res.status(200).json({
			data: { personas },
		});
	} catch (error) {
		logger.error("Admin persona list failed", { error });
		res.status(500).json({
			message: "Failed to load personas",
		});
	}
}

export async function adminUpdatePersona(
	req: Request,
	res: Response,
): Promise<void> {
	try {
		const persona =
			await personaService.updatePersona(
				req.params.personaKey,
				req.body,
			);
		res.status(200).json({
			data: { persona },
		});
	} catch (error) {
		logger.error("Admin persona update failed", {
			error,
			personaKey: req.params.personaKey,
		});
		res.status(500).json({
			message: "Failed to update persona",
		});
	}
}
