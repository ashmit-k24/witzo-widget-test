import { Request, Response } from "express";
import {
	coercePlanType,
	getPlanCapabilities,
} from "../config/planConfig";
import { leadService } from "../services/leadService";
import logger from "../utils/logger";

export const listLeads = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = req.user?.id;
		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const planType = coercePlanType(
			req.user?.plan_type,
		);
		const planLeadLimit =
			getPlanCapabilities(planType).leadStorageLimit;
		const requestedLimit = Number(req.query.limit);
		const listLimit =
			Number.isFinite(requestedLimit) && requestedLimit > 0
				? Math.min(Math.trunc(requestedLimit), 1000)
				: 1000;
		const responseLimit = planLeadLimit ?? listLimit;

		const status = req.query.status as string | undefined;
		const search = req.query.search as string | undefined;

		const { leads, total } =
			await leadService.getLeads(userId, {
				page: 1,
				limit: responseLimit,
				status,
				search,
			});

		res.status(200).json({
				success: true,
				data: leads,
				meta: {
					total,
				planLeadLimit,
				planType,
			},
		});
	} catch (error) {
		logger.error("Error listing leads", { error });
		res.status(500).json({
			success: false,
			message: "Failed to fetch leads",
		});
	}
};

export const getLead = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = req.user?.id;
		const { id } = req.params;

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const lead = await leadService.getLead(userId, id);

		if (!lead) {
			res.status(404).json({
				success: false,
				message: "Lead not found",
			});
			return;
		}

		const planType = coercePlanType(
			req.user?.plan_type,
		);
		const planLeadLimit =
			getPlanCapabilities(planType).leadStorageLimit;
		if (planLeadLimit !== null) {
			const { leads } = await leadService.getLeads(userId, {
				page: 1,
				limit: planLeadLimit,
			});
			if (!leads.some((visibleLead) => visibleLead.id === lead.id)) {
				res.status(403).json({
					success: false,
					message: "Lead is locked under your current plan",
				});
				return;
			}
		}

		res.status(200).json({
			success: true,
			data: lead,
		});
	} catch (error) {
		logger.error("Error fetching lead", { error });
		res.status(500).json({
			success: false,
			message: "Failed to fetch lead",
		});
	}
};

export const updateLeadStatus = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = req.user?.id;
		const { id } = req.params;
		const { status } = req.body;

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		if (!status) {
			res.status(400).json({
				success: false,
				message: "status is required",
			});
			return;
		}

		const lead = await leadService.updateLeadStatus(
			userId,
			id,
			status,
		);

		if (!lead) {
			res.status(404).json({
				success: false,
				message: "Lead not found",
			});
			return;
		}

		res.status(200).json({
			success: true,
			data: lead,
		});
	} catch (error: any) {
		if (error.message === "Invalid status value") {
			res.status(400).json({
				success: false,
				message:
					"Invalid status. Use: new, contacted, qualified, converted",
			});
			return;
		}
		logger.error("Error updating lead status", { error });
		res.status(500).json({
			success: false,
			message: "Failed to update lead status",
		});
	}
};

export const deleteLead = async (
	req: Request,
	res: Response,
): Promise<void> => {
	try {
		const userId = req.user?.id;
		const { id } = req.params;

		if (!userId) {
			res.status(401).json({
				success: false,
				message: "Authentication required",
			});
			return;
		}

		const deleted = await leadService.deleteLead(
			userId,
			id,
		);

		if (!deleted) {
			res.status(404).json({
				success: false,
				message: "Lead not found",
			});
			return;
		}

		res.status(200).json({
			success: true,
			message: "Lead deleted successfully",
		});
	} catch (error) {
		logger.error("Error deleting lead", { error });
		res.status(500).json({
			success: false,
			message: "Failed to delete lead",
		});
	}
};
