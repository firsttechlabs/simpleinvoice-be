import { v2 as cloudinary } from "cloudinary";
import {
  endOfDay,
  endOfMonth,
  startOfDay,
  startOfMonth,
  subDays,
  subMonths,
} from "date-fns";
import { Request, Router } from "express";
import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { sendInvoiceEmail, sendPaymentProofEmail } from "../utils/email";
import { prisma } from "../utils/prisma";

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const router = Router();

// Configure multer with Cloudinary storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req: Request, file: Express.Multer.File) => {
    const currentDate = new Date();
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    
    // Get invoice ID from params
    const invoiceId = req.params.id;
    
    // Create a structured folder path:
    // fakturly/payment-proofs/YYYY/MM/invoice-id/
    const folderPath = `fakturly/payment-proofs/${year}/${month}/${invoiceId}`;
    
    return {
      folder: folderPath,
      allowed_formats: ["jpg", "jpeg", "png"],
      transformation: [
        { width: 1000, height: 1000, crop: "limit" },
        { quality: "auto" },
        { fetch_format: "auto" }
      ],
      // Use a more descriptive public_id
      public_id: `proof-${Date.now()}`,
      // Add tags for better organization
      tags: ['payment-proof', `invoice-${invoiceId}`, `year-${year}`, `month-${month}`]
    };
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req: Request, file: Express.Multer.File, cb: any) => {
    const allowedTypes = /jpeg|jpg|png/;
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype) {
      cb(null, true);
    } else {
      cb(new Error("Hanya file gambar yang diperbolehkan (JPG, JPEG, PNG)"));
    }
  }
});

const createInvoiceSchema = z.object({
  customerId: z.string(),
  date: z.string(),
  dueDate: z.string(),
  items: z.array(
    z.object({
      description: z.string(),
      quantity: z.number(),
      price: z.number()
    })
  ),
  notes: z.string().optional(),
  taxRate: z.number()
});

const updateInvoiceSchema = z.object({
  status: z.enum(["UNPAID", "PAID", "OVERDUE", "CANCELLED"]).optional(),
  paymentProof: z.string().nullable().optional(),
  paymentNote: z.string().nullable().optional(),
  dueDate: z.string().datetime().optional(),
  notes: z.string().optional(),
  paidAt: z.string().datetime().optional().transform((val) => val ? new Date(val) : undefined),
});

router.use(authenticate);

// Get all invoices
router.get("/", async (req, res, next) => {
  try {
    const invoices = await prisma.invoice.findMany({
      where: { userId: (req as any).user.id },
      include: {
        items: true,
        customer: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({
      status: "success",
      data: invoices,
    });
  } catch (error) {
    next(error);
  }
});

// Get single invoice
router.get("/:id", async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: {
        id: req.params.id,
        userId: (req as any).user.id,
      },
      include: {
        user: {
          select: {
            name: true,
            email: true,
            businessName: true,
            address: true,
            phone: true
          }
        },
        customer: true,
        items: true
      },
    });

    if (!invoice) {
      throw new AppError(404, "Invoice not found");
    }

    res.json({
      status: "success",
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
});

// Create invoice
router.post("/", authenticate, async (req, res, next) => {
  try {
    const userId = (req as any).user.id;
    const data = createInvoiceSchema.parse(req.body);

    // Calculate totals
    const subtotal = data.items.reduce(
      (sum, item) => sum + item.quantity * item.price,
      0
    );
    const tax = (subtotal * data.taxRate) / 100;
    const total = subtotal + tax;

    // Get next invoice number
    const settings = await prisma.settings.findUnique({
      where: { userId },
    });

    if (!settings) {
      throw new AppError(400, "User settings not found");
    }

    const invoicePrefix = settings.invoicePrefix || "INV";
    const nextNumber = settings.nextInvoiceNumber;
    const invoiceNumber = `${invoicePrefix}${String(nextNumber).padStart(
      5,
      "0"
    )}`;

    // Create invoice with items
    const invoice = await prisma.invoice.create({
      data: {
        number: invoiceNumber,
        date: new Date(data.date),
        dueDate: new Date(data.dueDate),
        subtotal,
        tax,
        total,
        notes: data.notes,
        userId,
        customerId: data.customerId,
        items: {
          create: data.items.map((item) => ({
            description: item.description,
            quantity: item.quantity,
            price: item.price,
            amount: item.quantity * item.price,
          })),
        },
      },
      include: {
        items: true,
        customer: true,
      },
    });

    // Increment invoice number
    await prisma.settings.update({
      where: { userId },
      data: {
        nextInvoiceNumber: {
          increment: 1,
        },
      },
    });

    res.json({
      status: "success",
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
});

// Upload payment proof
router.post("/:id/payment-proof", upload.single("file"), async (req, res) => {
  try {
    const { id } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: "Tidak ada file yang diunggah"
      });
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            name: true,
            email: true,
            businessName: true,
            address: true,
            phone: true
          }
        },
        customer: true,
        items: true
      }
    });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Faktur tidak ditemukan"
      });
    }

    if (invoice.status === "PAID") {
      return res.status(400).json({
        success: false,
        message: "Faktur sudah lunas"
      });
    }

    if (invoice.status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Faktur sudah dibatalkan"
      });
    }

    // Return the Cloudinary URL
    return res.json({
      success: true,
      data: {
        url: file.path // Cloudinary URL will be in file.path
      }
    });
  } catch (error) {
    console.error("Error uploading payment proof:", error);
    return res.status(500).json({
      success: false,
      message: "Gagal mengunggah bukti pembayaran"
    });
  }
});

// Update invoice
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = updateInvoiceSchema.safeParse(req.body);

    if (!updateData.success) {
      return res.status(400).json({
        success: false,
        message: "Data tidak valid",
        errors: updateData.error.errors
      });
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            name: true,
            email: true,
            businessName: true,
            address: true,
            phone: true
          }
        },
        customer: true,
        items: true
      }
    });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Faktur tidak ditemukan"
      });
    }

    // Only allow cancellation for paid invoices
    if (invoice.status === "PAID" && updateData.data.status !== "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Faktur yang sudah lunas tidak dapat diubah statusnya"
      });
    }

    // Don't allow any changes to cancelled invoices
    if (invoice.status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Faktur yang sudah dibatalkan tidak dapat diubah"
      });
    }

    // If marking as paid, ensure paidAt is set
    const finalUpdateData = { 
      ...updateData.data,
      // Map paymentNote to notes if it exists in the update data
      notes: 'paymentNote' in updateData.data ? updateData.data.paymentNote : undefined,
      // Ensure paymentProof is included in the update
      paymentProof: updateData.data.paymentProof
    };
    
    // Remove paymentNote as it's not a valid field
    if ('paymentNote' in finalUpdateData) {
      delete (finalUpdateData as any).paymentNote;
    }

    if (finalUpdateData.status === "PAID" && invoice.status !== "PAID") {
      finalUpdateData.paidAt = new Date();
    }

    const updatedInvoice = await prisma.invoice.update({
      where: { id },
      data: finalUpdateData
    });

    return res.json({
      success: true,
      data: updatedInvoice
    });
  } catch (error) {
    console.error("Error updating invoice:", error);
    return res.status(500).json({
      success: false,
      message: "Gagal memperbarui faktur"
    });
  }
});

// Delete invoice
router.delete("/:id", async (req, res, next) => {
  try {
    await prisma.invoice.delete({
      where: {
        id: req.params.id,
        userId: (req as any).user.id,
      },
    });

    res.json({
      status: "success",
      data: null,
    });
  } catch (error) {
    next(error);
  }
});

// Send invoice
router.post("/:id/send", async (req: Request & { user?: { id: string } }, res) => {
  const { id } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const invoice = await prisma.invoice.findFirst({
      where: {
        id,
        userId,
      },
      include: {
        customer: true,
        items: true,
        user: {
          select: {
            name: true,
            email: true,
            businessName: true,
            address: true,
            phone: true
          }
        }
      }
    });

    if (!invoice) {
      throw new Error("Invoice not found");
    }

    if (invoice.status === "CANCELLED") {
      throw new Error("Cannot send cancelled invoice");
    }

    await sendInvoiceEmail(invoice);

    res.json({ message: "Invoice sent successfully" });
  } catch (error) {
    console.error("Error sending invoice:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to send invoice" });
  }
});

// Get dashboard statistics
router.get("/stats/overview", authenticate, async (req, res, next) => {
  try {
    const userId = (req as any).user.id;
    const today = new Date();
    const thirtyDaysAgo = subDays(today, 30);
    const startOfCurrentMonth = startOfMonth(today);
    const endOfCurrentMonth = endOfMonth(today);
    const startOfLastMonth = startOfMonth(subMonths(today, 1));
    const endOfLastMonth = endOfMonth(subMonths(today, 1));

    // Get total invoices and amount
    const [totalInvoices, totalAmount, unpaidAmount, overdueAmount] =
      await Promise.all([
        prisma.invoice.count({ where: { userId } }),
        prisma.invoice.aggregate({
          where: { userId, status: "PAID" },
          _sum: { total: true },
        }),
        prisma.invoice.aggregate({
          where: { userId, status: "UNPAID" },
          _sum: { total: true },
        }),
        prisma.invoice.aggregate({
          where: { userId, status: "OVERDUE" },
          _sum: { total: true },
        }),
      ]);

    // Get daily revenue for the last 30 days
    const dailyRevenue = await prisma.invoice.findMany({
      where: {
        userId,
        status: "PAID",
        date: {
          gte: thirtyDaysAgo,
          lte: today,
        },
      },
      select: {
        date: true,
        total: true,
      },
      orderBy: {
        date: "asc",
      },
    });

    // Group daily revenue by date
    const dailyRevenueGrouped = dailyRevenue.reduce((acc: any[], invoice) => {
      const date = startOfDay(invoice.date);
      const existingDay = acc.find(
        (day) => day.date.getTime() === date.getTime()
      );

      if (existingDay) {
        existingDay.total += invoice.total;
      } else {
        acc.push({ date, total: invoice.total });
      }

      return acc;
    }, []);

    // Fill in missing days with zero revenue
    const dailyRevenueComplete = [];
    let currentDate = thirtyDaysAgo;

    while (currentDate <= today) {
      const existingDay = dailyRevenueGrouped.find(
        (day) => day.date.getTime() === startOfDay(currentDate).getTime()
      );

      dailyRevenueComplete.push({
        date: startOfDay(currentDate),
        total: existingDay ? existingDay.total : 0,
      });

      currentDate = new Date(currentDate.setDate(currentDate.getDate() + 1));
    }

    // Get current month and last month revenue
    const [currentMonthRevenue, lastMonthRevenue] = await Promise.all([
      prisma.invoice.aggregate({
        where: {
          userId,
          status: "PAID",
          date: {
            gte: startOfCurrentMonth,
            lte: endOfCurrentMonth,
          },
        },
        _sum: { total: true },
      }),
      prisma.invoice.aggregate({
        where: {
          userId,
          status: "PAID",
          date: {
            gte: startOfLastMonth,
            lte: endOfLastMonth,
          },
        },
        _sum: { total: true },
      }),
    ]);

    // Get status distribution
    const statusDistribution = await prisma.invoice.groupBy({
      by: ["status"],
      where: { userId },
      _count: true,
      orderBy: {
        status: "asc",
      },
    });

    res.json({
      status: "success",
      data: {
        overview: {
          totalInvoices,
          totalAmount: totalAmount._sum.total || 0,
          unpaidAmount: unpaidAmount._sum.total || 0,
          overdueAmount: overdueAmount._sum.total || 0,
        },
        dailyRevenue: dailyRevenueComplete,
        monthlyComparison: {
          currentMonth: currentMonthRevenue._sum.total || 0,
          lastMonth: lastMonthRevenue._sum.total || 0,
        },
        statusDistribution: statusDistribution.map((status) => ({
          name: status.status,
          value: status._count,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get revenue by date range
router.get("/stats/revenue", authenticate, async (req, res, next) => {
  try {
    const userId = (req as any).user.id;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      throw new AppError(400, "Start date and end date are required");
    }

    const start = startOfDay(new Date(startDate as string));
    const end = endOfDay(new Date(endDate as string));

    const revenue = await prisma.invoice.groupBy({
      by: ["date"],
      where: {
        userId,
        date: {
          gte: start,
          lte: end,
        },
        status: "PAID",
      },
      _sum: {
        total: true,
      },
      orderBy: {
        date: "asc",
      },
    });

    res.json({
      status: "success",
      data: revenue,
    });
  } catch (error) {
    next(error);
  }
});

export const invoiceRouter = router;
