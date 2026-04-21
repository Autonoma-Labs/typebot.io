import { env } from "@typebot.io/env";
import prisma from "@typebot.io/prisma";
import { WorkspaceRole } from "@typebot.io/prisma/enum";
import { parseWorkspaceDefaultPlan } from "@typebot.io/workspaces/parseWorkspaceDefaultPlan";
import bcrypt from "bcryptjs";
import { createId } from "@paralleldrive/cuid2";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { email, password, name } = await req.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 },
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 },
      );
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "User with this email already exists" },
        { status: 409 },
      );
    }

    // Check signup restrictions
    if (env.DISABLE_SIGNUP && !env.ADMIN_EMAIL?.includes(email)) {
      return NextResponse.json(
        { error: "Sign up is currently disabled" },
        { status: 403 },
      );
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user with workspace
    const user = await prisma.user.create({
      data: {
        id: createId(),
        email,
        name: name || email.split("@")[0],
        hashedPassword,
        onboardingCategories: [],
        workspaces: {
          create: {
            role: WorkspaceRole.ADMIN,
            workspace: {
              create: {
                name: name ? `${name}'s workspace` : "My workspace",
                plan: parseWorkspaceDefaultPlan(email),
              },
            },
          },
        },
      },
    });

    return NextResponse.json(
      {
        success: true,
        message: "Account created successfully",
        userId: user.id,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Signup error:", error);
    return NextResponse.json(
      { error: "An error occurred during signup" },
      { status: 500 },
    );
  }
}
