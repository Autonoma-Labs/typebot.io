import { NextResponse } from "next/server";
import {
  SignupError,
  createUserWithDefaultWorkspace,
} from "./createUserWithDefaultWorkspace";

export async function POST(req: Request) {
  try {
    const { email, password, name } = await req.json();

    const user = await createUserWithDefaultWorkspace({
      email,
      password,
      name,
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
    if (error instanceof SignupError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Signup error:", error);
    return NextResponse.json(
      { error: "An error occurred during signup" },
      { status: 500 },
    );
  }
}
