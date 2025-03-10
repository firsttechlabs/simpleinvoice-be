import { Router } from "express";
import { z } from "zod";
import { prisma } from "../utils/prisma";
import { authenticate } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import bcrypt from "bcryptjs";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";

const router = Router();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure multer with Cloudinary storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req: Request, file: Express.Multer.File) => {
    const currentDate = new Date();
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, "0");
    const userId = (req as any).user.id;

    return {
      folder: `fakturly/settings/profile/${year}/${month}/${userId}`,
      allowed_formats: ["jpg", "jpeg", "png"],
      transformation: [
        { width: 500, height: 500, crop: "limit" },
        { quality: "auto" },
        { fetch_format: "auto" },
      ],
      public_id: `logo-${Date.now()}`,
    };
  },
});

const upload = multer({ storage });

const updatePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8, "Kata sandi minimal 8 karakter"),
});

const updateProfileSchema = z.object({
  businessName: z.string().min(2, "Nama usaha minimal 2 karakter").optional(),
  businessLogo: z.string().optional(),
  businessAddress: z.string()
    .transform(val => val === "" ? null : val)
    .nullable()
    .optional(),
  businessPhone: z.string()
    .transform(val => val === "" ? null : val)
    .refine(val => val === null || /^(\+62|62|0)8[1-9][0-9]{6,9}$/.test(val), {
      message: "Format nomor telepon tidak valid (contoh: 081234567890)",
    })
    .nullable()
    .optional(),
  businessEmail: z.string()
    .transform(val => val === "" ? null : val)
    .refine(val => val === null || /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(val), {
      message: "Format email tidak valid",
    })
    .nullable()
    .optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8, "Kata sandi minimal 8 karakter").optional(),
});

// Get user count
router.get("/count", async (req, res, next) => {
  try {
    const count = await prisma.user.count({
      where: {
        isActive: true,
      },
    });

    res.json({
      status: "success",
      data: { count },
    });
  } catch (error) {
    next(error);
  }
});

router.use(authenticate);

// Get user profile
router.get("/profile", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: (req as any).user.id },
      select: {
        id: true,
        email: true,
        businessName: true,
        businessLogo: true,
        businessAddress: true,
        businessPhone: true,
        businessEmail: true,
        isGoogleUser: true,
        hasPassword: true,
        settings: {
          select: {
            invoicePrefix: true,
            taxRate: true,
            licenseKey: true,
            licenseStatus: true,
          },
        },
      },
    });

    if (!user) {
      throw new AppError(404, "Pengguna tidak ditemukan");
    }

    res.json({
      status: "success",
      data: user,
    });
  } catch (error) {
    next(error);
  }
});

// Update user profile
router.patch("/profile", authenticate, async (req, res, next) => {
  try {
    const userId = (req as any).user.id;
    const data = updateProfileSchema.parse(req.body);

    // Get current user to check if it's a Google user
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        isGoogleUser: true,
        password: true,
        hasPassword: true,
      },
    });

    if (!currentUser) {
      throw new AppError(404, "Pengguna tidak ditemukan");
    }

    // Remove password fields from data before update
    const { currentPassword, newPassword, ...updateData } = data;

    // Handle password update if provided
    let passwordUpdate = {};
    if (newPassword) {
      // For users who have set a password before, require current password
      if (currentUser.hasPassword && !currentPassword) {
        throw new AppError(400, "Kata sandi saat ini wajib diisi");
      }

      // If user has password set, verify current password
      if (currentUser.hasPassword && currentPassword) {
        const validPassword = await bcrypt.compare(
          currentPassword,
          currentUser.password
        );
        if (!validPassword) {
          throw new AppError(400, "Kata sandi saat ini tidak sesuai");
        }

        // Check if new password is same as current password
        const isSamePassword = await bcrypt.compare(
          newPassword,
          currentUser.password
        );
        if (isSamePassword) {
          throw new AppError(400, "Kata sandi baru tidak boleh sama dengan kata sandi sebelumnya");
        }
      }

      // Hash new password and set hasPassword to true
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      passwordUpdate = {
        password: hashedPassword,
        hasPassword: true,
      };
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...updateData,
        ...passwordUpdate,
      },
      select: {
        id: true,
        email: true,
        businessName: true,
        businessLogo: true,
        businessAddress: true,
        businessPhone: true,
        businessEmail: true,
        isGoogleUser: true,
        hasPassword: true,
      },
    });

    res.json({
      status: "success",
      data: updatedUser,
    });
  } catch (error) {
    next(error);
  }
});

// Get active user count
router.get("/active-count", async (req, res) => {
  try {
    const activeUserCount = await prisma.user.count({
      where: {
        isActive: true,
      },
    });

    return res.json({ count: activeUserCount });
  } catch (error) {
    console.error("Error getting active user count:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Upload business logo
router.post(
  "/profile/logo",
  authenticate,
  upload.single("logo"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new AppError(400, "Tidak ada file yang diunggah");
      }

      const userId = (req as any).user.id;
      const logoUrl = req.file.path;

      // Update user with new logo URL
      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { businessLogo: logoUrl },
        select: {
          id: true,
          email: true,
          businessName: true,
          businessLogo: true,
          businessAddress: true,
          businessPhone: true,
          businessEmail: true,
        },
      });

      res.json({
        status: "success",
        data: updatedUser,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Update password endpoint
router.patch("/profile/password", authenticate, async (req, res, next) => {
  try {
    const userId = (req as any).user.id;
    const data = updatePasswordSchema.parse(req.body);

    // Get current user to check status
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        isGoogleUser: true,
        password: true,
        hasPassword: true,
      },
    });

    if (!currentUser) {
      throw new AppError(404, "Pengguna tidak ditemukan");
    }

    // Verifikasi password lama jika:
    // 1. User manual (non-Google)
    // 2. User Google yang sudah pernah set password
    if (!currentUser.isGoogleUser || (currentUser.isGoogleUser && currentUser.hasPassword)) {
      if (!data.currentPassword) {
        throw new AppError(400, "Kata sandi saat ini wajib diisi");
      }

      const validPassword = await bcrypt.compare(
        data.currentPassword,
        currentUser.password
      );
      if (!validPassword) {
        throw new AppError(400, "Kata sandi saat ini tidak sesuai");
      }

      // Check if new password is same as current password
      const isSamePassword = await bcrypt.compare(
        data.newPassword,
        currentUser.password
      );
      if (isSamePassword) {
        throw new AppError(400, "Kata sandi baru tidak boleh sama dengan kata sandi sebelumnya");
      }
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(data.newPassword, 10);

    // Update user password and set hasPassword to true
    await prisma.user.update({
      where: { id: userId },
      data: { 
        password: hashedPassword,
        hasPassword: true 
      },
    });

    res.json({
      status: "success",
      message: currentUser.hasPassword ? "Kata sandi berhasil diperbarui" : "Kata sandi berhasil diatur",
    });
  } catch (error) {
    next(error);
  }
});

export const userRouter = router;
