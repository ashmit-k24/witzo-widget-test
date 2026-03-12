import { Request, Response } from "express";
import {
	subscriptionService,
	UpsertPlanInput,
} from "../services/subscriptionService";
import logger from "../utils/logger";

const parseFeatures = (
	features: unknown,
): unknown => {
	if (features === undefined) {
		return [];
	}
	if (typeof features === "string") {
		try {
			return JSON.parse(features);
		} catch {
			throw new Error(
				"features must be valid JSON when provided as string.",
			);
		}
	}
	return features;
};

const toUpsertPayload = (
	body: Record<string, unknown>,
): UpsertPlanInput => {
	const name = String(body.name ?? "")
		.trim()
		.toLowerCase();
	return {
		name,
		description:
			typeof body.description === "string"
				? body.description.trim()
				: null,
		monthlyPrice: Number(body.monthlyPrice ?? 0),
		yearlyPrice: Number(body.yearlyPrice ?? 0),
		razorpayMonthlyPlanId:
			typeof body.razorpayMonthlyPlanId ===
			"string"
				? body.razorpayMonthlyPlanId.trim()
				: null,
		razorpayYearlyPlanId:
			typeof body.razorpayYearlyPlanId ===
			"string"
				? body.razorpayYearlyPlanId.trim()
				: null,
		features: parseFeatures(body.features),
		websitePagesLimit:
			body.websitePagesLimit === "" ||
			body.websitePagesLimit === null ||
			body.websitePagesLimit === undefined
				? null
				: Number(body.websitePagesLimit),
		isActive:
			typeof body.isActive === "boolean"
				? body.isActive
				: true,
	};
};

export const listPlans = async (
	_req: Request,
	res: Response,
): Promise<void> => {
	try {
		const plans =
			await subscriptionService.listPlans(true);
		res.status(200).json({
			data: plans,
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to fetch plans";
		logger.error(
			"Admin failed to fetch plans",
			{
				error: message,
			},
		);
		res.status(400).json({
			message,
		});
	}
};

export const createPlan = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const payload = toUpsertPayload(
			req.body as Record<string, unknown>,
		);
		const plan =
			await subscriptionService.createPlan(
				payload,
			);
		res.status(201).json({
			data: plan,
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to create plan";
		logger.error(
			"Admin failed to create plan",
			{
				error: message,
			},
		);
		res.status(400).json({
			message,
		});
	}
};

export const updatePlan = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const planId = Number(req.params.id);
		if (!Number.isInteger(planId) || planId <= 0) {
			res.status(400).json({
				message:
					"Plan id must be a positive integer.",
			});
			return;
		}

		const payload = toUpsertPayload(
			req.body as Record<string, unknown>,
		);
		const plan =
			await subscriptionService.updatePlan(
				planId,
				payload,
			);
		res.status(200).json({
			data: plan,
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Failed to update plan";
		logger.error(
			"Admin failed to update plan",
			{
				error: message,
			},
		);
		res.status(400).json({
			message,
		});
	}
};
