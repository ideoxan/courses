import { createClient } from "@supabase/supabase-js"
import "dotenv/config"
import glob from "glob"
import { readFile, stat, readdir} from "fs/promises"
import { lookup } from "mime-types"
import YAML from "yaml"
import path from "path"
import fm from "front-matter"
import tar from "tar"
import { existsSync } from "fs"

main()

export default async function main() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)
    // Our goal is to parse all of the files in this directory (with the exception of
    // node_modules) and upload them to the Supabase database. However, this time around we will
    // parse yaml files and add entries to the database. Workspace directories will be packed as
    // tarballs and uploaded to the bucket.

    // We will follow these steps:
    // 0. Delete all lesson-related entries in the database.
    // 1. Get the base directory of this project.
    // 2. Get a list of all courses in this directory.
    // 3. For each course:
    //      3.1 Parse course metadata from the `courses.yaml` file.
    //      3.2 Add the course to the database, keep track of the UUID
    //      3.3 Get a list of all chapters in this course.
    //      3.4 For each chapter:
    //          3.4.1 Get a list of all lessons in this chapter
    //          3.4.2 Add the chapter to the database, keep track of the UUID
    //          3.4.3 For each lesson:
    //              3.4.3.1 Parse the guide.md file (WE ARE NOT GOING TO READ THE MARKDOWN ITSELF,
    //                      JUST THE FRONT MATTER YAML).
    //              3.4.3.2 Tarball the workspace directory.
    //              3.4.3.3 Upload the tarball to the bucket, inserting the object_id.
    //              3.4.3.4 Upload specific referenced files to the bucket, inserting the
    //                      object_id.
    //              3.4.3.5 Upload tasks and task conditions
    //              3.4.3.6 Add the lesson data to the database
    //      3.5 Loop through all lessons and chapters within the course, adding nav data

    // All entries (NOT TABLES FFS) should be deleted before we start...
    const badUUID = "123e4567-e89b-12d3-a456-426614174000"
    await supabase.from("task_conditions").delete().neq("id", badUUID)
    await supabase.from("tasks").delete().neq("id", badUUID)
    await supabase.from("lessons").delete().neq("id", badUUID)
    await supabase.from("chapters").delete().neq("id", badUUID)
    await supabase.from("courses").delete().neq("id", badUUID)

    const baseDir = process.cwd()
    console.log("Looking for courses in " + baseDir)

    const courses = await asyncGlob(`${ baseDir }/!(node_modules|.git)/`) // Filters node and git
    console.log(`Found ${ courses.length } courses.`)

    for (const course of courses) {
        // Grab the course metadata from the `courses.yaml` file.
        const courseMetadata = YAML.parse(await readFile(path.join(course, "course.yaml"), "utf8"))
        const { error: courseMetadataError } = await supabase.from("courses").upsert([{
            id: courseMetadata.uuid,
            name: courseMetadata.name,
            description: courseMetadata.description,
            tags: courseMetadata.tags,
            authors: courseMetadata.authors,
        }])
        if (courseMetadataError) {
            console.error(course.replace(baseDir, ""))
            console.error(courseMetadataError)
            return
        }
        console.log(`\tAdded course ${course.replace(baseDir, "")}`)

        // Get a list of all chapters in this course.
        const chapters = courseMetadata.chapters.map((chapter, i, arr) => {
            // convert to path safe strings
            return {
                name: chapter,
                pathSafe: chapter.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
                index: i
            }
        }).sort((a, b) => a.index - b.index)
        console.log(`\tFound ${ chapters.length } chapters.`)
        for (const chapter of chapters) {
            // Upload the chapter to the database.
            const { data: chapterMetadataData, error: chapterMetadataError } = await supabase.from("chapters").upsert([{
                course: courseMetadata.uuid,
                name: chapter.name,
                index: chapter.index,
            }])
            if (chapterMetadataError) {
                console.error(`${ course }/${ chapter.pathSafe }`.replace(baseDir, ""))
                console.error(chapterMetadataError)
                return
            }
            console.log(`\t\tAdded chapter ${ `${ course }${ chapter.pathSafe }`.replace(baseDir, "") }`)

            // Get a list of all lessons in this chapter.
            const lessons = await asyncGlob(`${ course }/${ chapter.pathSafe }/!(node_modules|.git)/`)
            console.log(`\t\tFound ${ lessons.length } lessons.`)
            for (let i = 0; i < lessons.length; i++) {
                const lesson = lessons[i]
                // Parse the guide.md file
                const guide = fm(await readFile(path.join(lesson, "guide.md"), "utf8"))
                const { attributes: lessonMetadata } = guide
                // Add the lesson data to the database
                const { data: lessonMetadataData, error: lessonMetadataError } = await supabase.from("lessons").upsert([{
                    chapter: chapterMetadataData[0].id,
                    name: lessonMetadata.name,
                    environment: lessonMetadata.environment,
                    index: i,
                }])
                if (lessonMetadataError) {
                    console.error(`${ lesson }`.replace(baseDir, ""))
                    console.error(lessonMetadataError)
                    return
                }
                console.log(`\t\t\tAdded lesson ${ `${ lesson }`.replace(baseDir, "") }`)

                // Upload body of guide.md to the bucket
                const { data: guideUploadData, error: guideUploadError } = await supabase
                    .storage
                    .from("guides")
                    .upload(`guide-${ lessonMetadataData[0].id }.md`, guide.body.toString("utf8"), {
                        upsert: true,
                        contentType: "text/markdown",
                    })
                if (guideUploadError) {
                    console.error(`${ lesson }`.replace(baseDir, ""))
                    console.error(guideUploadError)
                    return
                }
                console.log(`\t\t\t\tUploaded guide ${ `${ lesson }`.replace(baseDir, "") }`)

                // Tarball the workspace directory
                if (existsSync(path.join(lesson, "/workspace/"))) {
                    console.log(path.join(lesson, "/workspace/"))
                    const workspaceTarball = await promisifyStream(tar.create({
                        gzip: false,
                        portable: true,
                        preservePaths: false,
                        cwd: path.join(lesson, "/workspace/"),
                    }, await readdir(path.join(lesson, "/workspace/"))))

                    // Upload the tarball to the bucket
                    const { data: workspaceUploadData, error: workspaceUploadError } = await supabase
                        .storage
                        .from("starter-workspaces")
                        .upload(`workspace-${ lessonMetadataData[0].id }.tar`, workspaceTarball, {
                            upsert: true,
                            contentType: "application/x-tar",
                        })
                    if (workspaceUploadError) {
                        console.error(`${ lesson }`.replace(baseDir, ""))
                        console.error(workspaceUploadError)
                        return
                    }
                    console.log(`\t\t\t\tUploaded workspace ${ `${ lesson }`.replace(baseDir, "") }`)

                    // Insert the keys of the uploaded files into the lesson entry in the database
                    const { data: lessonUpdateData, error: lessonUpdateError } = await supabase.from("lessons").update({
                        workspace: workspaceUploadData?.Key,
                    }).eq("id", lessonMetadataData[0].id)
                    if (lessonUpdateError) {
                        console.error(`${ lesson }`.replace(baseDir, ""))
                        console.error(lessonUpdateError)
                        return
                    }
                }


                // Insert the keys of the uploaded files into the lesson entry in the database
                const { data: lessonUpdateData, error: lessonUpdateError } = await supabase.from("lessons").update({
                    guide: guideUploadData.Key,
                }).eq("id", lessonMetadataData[0].id)
                if (lessonUpdateError) {
                    console.error(`${ lesson }`.replace(baseDir, ""))
                    console.error(lessonUpdateError)
                    return
                }


                // Upload each task
                for (let j = 0; j < lessonMetadata?.tasks?.length || 0; j++) {
                    // Insert task to the database
                    const { data: taskMetadataData, error: taskMetadataError } = await supabase.from("tasks").upsert([{
                        instructions: lessonMetadata.tasks[j].instructions,
                        lesson: lessonMetadataData[0].id,
                        index: j,
                        completed_by_default: lessonMetadata.tasks[j].completed_by_default,
                    }])
                    if (taskMetadataError) {
                        console.error(`${ lesson }`.replace(baseDir, ""))
                        console.error(taskMetadataError)
                        return
                    }
                    console.log(`\t\t\t\tAdded task ${ `${ lesson }`.replace(baseDir, "") }`)
                    // Upload each condition
                    for (let k = 0; k < lessonMetadata.tasks[j].conditions.length; k++) {
                        const condition = lessonMetadata.tasks[j].conditions[k]
                        if ((await stat(path.join(lesson, condition.value))).isFile()) {
                            // Upload specific referenced files in the metadata conditions to the
                            // bucket
                            const { data: fileUploadData, error: fileUploadError } = await supabase
                                .storage
                                .from("misc-course-content")
                                .upload(`file-${ lessonMetadataData[0].id }-${ condition.value.split("/").pop().replace(/[^a-z0-9]/gi, "-").toLowerCase() }`, await readFile(path.resolve(lesson, condition.value)), {
                                    upsert: true,
                                    contentType: lookup(condition.value),
                                })
                            if (fileUploadError) {
                                console.error(`${ path.resolve(lesson, condition.value) }`.replace(baseDir, ""))
                                console.error(fileUploadError)
                                return
                            }
                            console.log(`\t\t\t\tUploaded file ${ `${ path.resolve(lesson, condition.value) }`.replace(baseDir, "") }`)
                            lessonMetadata.tasks[j].conditions[k].value = fileUploadData.Key
                        }
                        // Insert condition into the database
                        const { error: conditionError } = await supabase.from("task_conditions").upsert([{
                            task: taskMetadataData[0].id,
                            type: condition.type,
                            in: condition.in,
                            is: condition.is,
                            value: condition.value,
                        }])
                        if (conditionError) {
                            console.error(conditionError)
                            return
                        }
                        console.log(`\t\t\t\tAdded condition ${ `${ lesson }`.replace(baseDir, "") }`)
                    }
                }
            }
        }

        // Loop through entire course and add navigation data (previous, next) to each lesson
        // if applicable
        console.log("\tAdding navigation data to lessons...")
        for (let i = 0; i < chapters.length; i++) {
            let { data: chapters, error: chaptersError } = await supabase
                .from("chapters")
                .select()
                .eq("course", courseMetadata.uuid)
                .order("index", { ascending: true })
            if (chaptersError) {
                console.error(chaptersError)
                return
            }
            let { data: lessons, error: lessonsError } = await supabase
                .from("lessons")
                .select()
                .eq("chapter", chapters[i].id)
                .order("index", { ascending: true })
            if (lessonsError) {
                console.error(lessonsError)
                return
            }
            console.log(`\t\tAdding navigation data to chapter ${ i }...`)
            for (let j = 0; j < lessons.length; j++) {
                console.log(`\t\t\tAdding navigation data to lesson ${ j }...`)
                // Add previous lesson. If there is a lesson before, add it. If there is no lesson
                // before in the chapter, check the previous chapter. If there is a previous
                // chapter, add the last lesson in that chapter. If there is no previous chapter,
                // add null.
                let previous = null
                if (j > 0) {
                    previous = `${ courseMetadata.uuid }/${ i }/${ j - 1 }`
                } else if (i > 0) {
                    let { data: previousChapterLessons, error: previousChapterLessonsError } = await supabase
                        .from("lessons")
                        .select()
                        .eq("chapter", chapters[i - 1].id)
                        .order("index", { ascending: true })
                    if (previousChapterLessonsError) {
                        console.error(previousChapterLessonsError)
                        return
                    }
                    previous = `${ courseMetadata.uuid }/${ i - 1 }/${ previousChapterLessons.length - 1 }`
                } else {
                    previous = null
                }
                // Add next lesson. If there is a lesson after, add it. If there is no lesson after
                // in the chapter, check the next chapter. If there is a next chapter, add the
                // first lesson in that chapter. If there is no next chapter, add null.
                let next = null
                if (j < lessons.length - 1) {
                    next = `${ courseMetadata.uuid }/${ i }/${ j + 1 }`
                } else if (i < chapters.length - 1) {
                    next = `${ courseMetadata.uuid }/${ i + 1 }/0`
                } else {
                    next = null
                }
                // Update the lesson with the previous and next lesson
                const { error: lessonUpdateError } = await supabase.from("lessons").update({
                    previous, next
                }).eq("id", lessons[j].id)
                if (lessonUpdateError) {
                    console.error(lessonUpdateError)
                    return
                }
            }
        }
    }
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

export async function promisifyStream(s) {
    return new Promise((resolve, reject) => {
        const chunks = []
        s.on("data", chunk => chunks.push(chunk))
        s.on("end", () => resolve(Buffer.concat(chunks)))
        s.on("error", reject)
    })
}
