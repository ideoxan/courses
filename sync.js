import { createClient } from "@supabase/supabase-js"
import "dotenv/config"
import glob from "glob"
import { readFile, stat } from "fs/promises"
import { lookup } from "mime-types"

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)

main()

export default async function main() {
    // Our goal is to upload all of the files in this directory (with the exception of
    // node_modules) to the Supabase database.

    // Unlike the previous version, we will actually go lesson by lesson, chapter by chapter, and
    // course by course to upload the files to the database.

    // While this is a bit more complicated and a little less efficient, it gives us the ability to
    // "map" or "index" the files needed for each lesson and append them to the database as a JSON
    // file

    // Now, lets start by getting the base directory of this project.
    const baseDir = process.cwd()

    // Now lets get the list of courses in this directory.
    console.log("Looking for courses in " + baseDir)
    const courses = await asyncGlob(`${ baseDir }/!(node_modules|.git)/`) // Filters node and git
    // Logging...
    courses.forEach(course => console.log(`\tFound course: .${ course.replace(baseDir, "") }`))
    console.log(`Found ${ courses.length } courses.`)

    // Now we want to iterate over each course and upload the files to the database.
    console.log("Uploading courses to database...")
    for (const course of courses) {
        // Lets upload the course information to the database.
        console.log(`\tUploading course metadata: .${ course.replace(baseDir, "") }`)
        const courseData = await readFile(`${ course }/course.json`)
        const { error: courseMetadataError } = await supabase
            .storage
            .from("course-content")
            .upload(`${ course.replace(baseDir, "") }/course.json`, courseData, {
                upsert: true,
                contentType: "application/json",
            })
        if (courseMetadataError) {
            console.log("\t\tFailed to upload course metadata: " + course.replace(baseDir, ""))
            console.log(courseMetadataError)
        } else {
            console.log("\t\tSuccessfully uploaded course metadata: " + course.replace(baseDir, ""))
        }

        // Lets get a list of all chapters in this course.
        console.log(`\tUploading files for course: .${ course.replace(baseDir, "") }`)
        const chapters = await asyncGlob(`${ course }/!(.git)/`)

        // Now we want to iterate over each chapter and upload the files to the database.
        for (const chapter of chapters) {
            // Lets upload the chapter information to the database.
            console.log(`\t\tUploading chapter metadata: .${ chapter.replace(baseDir, "") }`)
            const chapterData = await readFile(`${ chapter }/chapter.json`)
            const { error: chapterMetadataError } = await supabase
                .storage
                .from("course-content")
                .upload(`${ chapter.replace(baseDir, "") }/chapter.json`, chapterData, {
                    upsert: true,
                    contentType: "application/json",
                })
            if (chapterMetadataError) {
                console.log("\t\tFailed to upload chapter metadata: " + chapter.replace(baseDir, ""))
                console.log(chapterMetadataError)
            } else {
                console.log("\t\tSuccessfully uploaded chapter metadata: " + chapter.replace(baseDir, ""))
            }

            // Lets get a list of all lessons in this chapter.
            const lessons = await asyncGlob(`${ chapter }/!(.git)/`)
            // Now we want to iterate over each lesson and upload the files to the database.
            for (const lesson of lessons) {
                // Lets upload the lesson information to the database.
                console.log(`\tUploading lesson metadata: .${ lesson.replace(baseDir, "") }`)
                const lessonData = await readFile(`${ lesson }/lesson.json`)
                const { error: lessonMetadataError } = await supabase
                    .storage
                    .from("course-content")
                    .upload(`${ lesson.replace(baseDir, "") }/lesson.json`, lessonData, {
                        upsert: true,
                        contentType: "application/json",
                    })
                if (lessonMetadataError) {
                    console.log("\t\tFailed to upload lesson metadata: " + lesson.replace(baseDir, ""))
                    console.log(lessonMetadataError)
                } else {
                    console.log("\t\tSuccessfully uploaded lesson metadata: " + lesson.replace(baseDir, ""))
                }

                // Lets get a list of all of the files in the lesson workspace directory.
                const files = await asyncGlob(`${ lesson }/workspace/**/!(.git)`, {
                    dot: true,
                })
                // Now we want to iterate over each file and upload the files to the database.
                // We also want to collect the files in an array so we can upload the "map"
                const workspaceMap = []
                for (const file of files) {
                    if ((await stat(file)).isDirectory()) {
                        // This is a directory, so we can skip it.
                        continue
                    }
                    // Lets upload the file to the database.
                    console.log(`\tUploading file: .${ file.replace(baseDir, "") }`)
                    const fileData = await readFile(file)
                    const { error: lessonWorkspaceError } = await supabase
                        .storage
                        .from("course-content")
                        .upload(file.replace(baseDir, ""), fileData, {
                            upsert: true,
                            contentType: lookup(file.split('.').pop()),
                        })
                    if (lessonWorkspaceError) {
                        console.log("\t\tFailed to upload file: " + file.replace(baseDir, ""))
                        console.log(lessonWorkspaceError)
                    } else {
                        console.log("\t\tSuccessfully uploaded file: " + file.replace(baseDir, ""))
                        workspaceMap.push(file.replace(baseDir, ""))
                    }
                }
                // Now we want to upload the workspace map to the database.
                console.log(`\tUploading workspace map: .${ lesson.replace(baseDir, "") }`)
                const { error: lessonWorkspaceMapError } = await supabase
                    .storage
                    .from("course-content")
                    .upload(`${ lesson.replace(baseDir, "") }/workspace_map.json`, JSON.stringify(workspaceMap), {
                        upsert: true,
                        contentType: "application/json",
                    })
                if (lessonWorkspaceMapError) {
                    console.log("\t\tFailed to upload workspace map: " + lesson.replace(baseDir, ""))
                    console.log(lessonWorkspaceMapError)
                } else {
                    console.log("\t\tSuccessfully uploaded workspace map: " + lesson.replace(baseDir, ""))
                }

                // Lets also upload the lesson guide to the database along with the whole resources
                // folder
                console.log(`\tUploading lesson resources: .${ lesson.replace(baseDir, "") }`)
                const resources = await asyncGlob(`${ lesson }/resources/**/!(.git)`, {
                    dot: true,
                })
                for (const resource of resources) {
                    if ((await stat(resource)).isDirectory()) {
                        // This is a directory, so we can skip it.
                        continue
                    }
                    console.log(`\tUploading resource: .${ resource.replace(baseDir, "") }`)
                    const resourceData = await readFile(resource)
                    const { error: lessonResourcesError } = await supabase
                        .storage
                        .from("course-content")
                        .upload(resource.replace(baseDir, ""), resourceData, {
                            upsert: true,
                            contentType: lookup(resource.split('.').pop()),
                        })
                    if (lessonResourcesError) {
                        console.log("\t\tFailed to upload resource: " + resource.replace(baseDir, ""))
                        console.log(lessonResourcesError)
                    } else {
                        console.log("\t\tSuccessfully uploaded resource: " + resource.replace(baseDir, ""))
                    }
                }
                console.log(`\tFinished uploading ${ 1 + files.length + 1 + resources.length } files for course: .${ course.replace(baseDir, "") }`)
            }
        }
    }

    console.log(`Finished uploading ${ courses.length } courses to database.`)
}

export async function asyncGlob(pattern, options = {}) {
    return new Promise((resolve, reject) => {
        glob(pattern, options, (err, files) => {
            if (err) {
                reject(err)
            } else {
                resolve(files)
            }
        })
    })
}
